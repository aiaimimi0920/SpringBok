import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suiteFixture } from './suite-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';

const names=['APP_COOKIE_SECRET','APP_STORAGE_KEY'];
const values={APP_COOKIE_SECRET:'Synthetic-Cookie-Secret!42',APP_STORAGE_KEY:'synthetic-storage-key-only'};
async function fixture(){
  const f=await suiteFixture();
  f.state.declaration.applicationSecrets=names;
  f.state.manifestOverride.secrets.push(...names);
  const resource=body=>f.f.call('/api/admin/resources',{...f.session,body});
  const save=patch=>resource({action:'application-secrets',id:randomUUID(),repository:'owner/repo',applicationId:'demo-app',values,...patch});
  // The common manifest fixture owns the actual application identity.
  const applicationResponse=await f.api('application',{github:f.input.github,repository:'owner/repo',sourceSha:f.input.sourceSha});
  if(applicationResponse.status!==200){await f.f.close();assert.fail(applicationResponse.text);}
  const application=applicationResponse.json();
  const applicationId=application.manifest.id;
  const create=patch=>save({applicationId,...patch});
  const profile=(await create()).json().profile;
  f.input.applicationSecrets={id:profile.id,revision:profile.revision};
  return {...f,resource,create,profile,applicationId};
}

test('application secrets are encrypted, owner-bound, never public and delivered once from an immutable task snapshot',async()=>{
  const f=await fixture();
  try{
    const plan=await f.preview(); assert.deepEqual(plan.plan.applicationSecrets,f.input.applicationSecrets);
    const listing=await f.f.call('/api/admin/resources',f.session);
    for(const secret of Object.values(values)){assert.ok(!listing.text.includes(secret));assert.ok(!JSON.stringify(plan).includes(secret));}
    assert.equal((await f.submit(plan)).status,200);
    const ns=await f.f.mf.getDurableObjectNamespace('CONNECTIONS'),vault=ns.get(ns.idFromName('connections/v1/'+f.auth.ownerId));
    const stored=JSON.stringify(await vault.inspectApplicationSecrets());
    for(const secret of Object.values(values))assert.ok(!stored.includes(secret));
    assert.match(stored,/application-secret/);assert.match(stored,/cipher/);
    assert.equal((await f.resource({action:'disable-application-secrets',...f.input.applicationSecrets})).status,200);
    await f.f.restart();
    assert.equal((await f.submit(plan)).status,200);assert.equal(f.state.dispatches,1);
    const permit=await(await f.machine()).json();
    for(const [name,value] of Object.entries(values))assert.equal(permit.secrets[name],value);
    assert.equal((await f.machine()).status,403);
    assert.equal((await f.api('plan',f.input)).status,409,'disabled profiles cannot authorize new tasks');
    const publicState=(await f.api('state',{taskId:plan.taskId})).text;
    for(const secret of Object.values(values))assert.ok(!publicState.includes(secret));
  }finally{await f.f.close();}
});

test('CSRF, foreign owners, wrong application/repository/names and stale revisions reject before any cloud write',async()=>{
  const f=await fixture();
  try{
    const noCsrf=await f.f.call('/api/admin/resources',{token:f.session.token,body:{action:'application-secrets',id:randomUUID(),repository:'owner/repo',applicationId:f.applicationId,values}});
    assert.equal(noCsrf.status,403);
    const foreign=await f.f.call('/api/admin/resources',{token:f.f.jwt({sub:'foreign'})});
    assert.deepEqual(foreign.json().applicationSecretProfiles,[]);
    for(const patch of [{repository:'other/repo'},{applicationId:'different-app'},{values:{APP_COOKIE_SECRET:'synthetic-only'}}]){
      const saved=(await f.create(patch)).json().profile;
      assert.equal((await f.api('plan',{...f.input,applicationSecrets:{id:saved.id,revision:1}})).status,409);
    }
    for(const applicationSecrets of [undefined,{...f.input.applicationSecrets,revision:999},{id:randomUUID(),revision:1}]){
      const input={...f.input};if(applicationSecrets)input.applicationSecrets=applicationSecrets;else delete input.applicationSecrets;
      assert.equal((await f.api('plan',input)).status,409);
    }
    assert.equal(f.state.created.length,0);assert.equal(f.state.dispatches,0);
  }finally{await f.f.close();}
});

test('selected secret-set identity is part of plan digest; reference substitution cannot pass confirmation',async()=>{
  const f=await fixture();
  try{
    const first=await f.preview(),other=(await f.create()).json().profile;
    const changed={...f.input,applicationSecrets:{id:other.id,revision:1}};
    const second=(await f.api('plan',changed)).json();
    assert.notEqual(first.plan.digest,second.plan.digest);
    assert.equal((await f.submit({...first,draft:changed})).status,409);
    assert.equal(f.state.created.length,0);assert.equal(f.state.dispatches,0);
  }finally{await f.f.close();}
});

test('updates inherit the original secret reference, previews bind it separately, and verify grants no write credentials',async()=>{
  const f=await fixture();
  try{
    const first=await f.preview();await f.submit(first);f.complete(await(await f.machine()).json());
    await f.service('service-state',{instanceId:first.taskId,reconcile:true});
    const input={...f.input,sourceSha:updatedSha,instance:{id:first.taskId,previousTaskId:first.taskId}};
    assert.equal((await f.api('plan',input)).status,409,'no implicit secret replacement on update');
    delete input.applicationSecrets;
    const update=(await f.api('plan',input)).json();assert.deepEqual(update.plan.applicationSecrets,f.input.applicationSecrets);
    assert.equal((await f.submit(update)).status,200);
    const permit=await(await f.machine()).json();assert.equal(permit.secrets.APP_COOKIE_SECRET,values.APP_COOKIE_SECRET);
    f.complete(permit);await f.service('service-state',{instanceId:first.taskId,reconcile:true});
    const verify=await f.service('verify',{instanceId:first.taskId,previousTaskId:update.taskId});assert.equal(verify.status,200,verify.text);
    const readonly=await(await f.machine()).json();
    assert.ok(Object.values(readonly.secrets).every(value=>value==='verification-not-applicable'));
  }finally{await f.f.close();}
});

test('secret values are bounded UTF-8 single-line strings and public declarations reject aliases',async()=>{
  const f=await fixture();
  try{
    for(const value of ['',null,'x'.repeat(513),'中'.repeat(171),'line\nvalue'])assert.equal((await f.create({values:{APP_COOKIE_SECRET:value}})).status,409);
    for(const applicationSecrets of [['CLOUDFLARE_API_TOKEN'],['APP_COOKIE_SECRET','APP_COOKIE_SECRET'],[]]){
      f.state.declaration.applicationSecrets=applicationSecrets;
      assert.equal((await f.api('plan',f.input)).status,409);
    }
  }finally{await f.f.close();}
});

test('authenticated encryption failure prevents all secret delivery and does not consume a permit',async()=>{
  const f=await fixture();
  try{
    const plan=await f.preview();await f.submit(plan);
    const ns=await f.f.mf.getDurableObjectNamespace('CONNECTIONS'),vault=ns.get(ns.idFromName('connections/v1/'+f.auth.ownerId));
    await vault.corruptApplicationTaskSecret(plan.taskId,names[0]);
    const denied=await f.machine();assert.equal(denied.status,403);
    for(const value of Object.values(values))assert.ok(!(await denied.clone().text()).includes(value));
    const tasks=await f.f.mf.getDurableObjectNamespace('CONNECTED_TASKS'),task=tasks.get(tasks.idFromName('connected/v1/'+plan.taskId));
    assert.equal((await task.inspect(f.auth.ownerId)).permitId,null);assert.equal(f.state.dispatches,1);
  }finally{await f.f.close();}
});

test('preview and cleanup get distinct immutable task snapshots without changing source references',async()=>{
  const f=await fixture();
  try{
    const first=await f.preview();await f.submit(first);f.complete(await(await f.machine()).json());
    await f.service('service-state',{instanceId:first.taskId,reconcile:true});
    const response=await f.service('plan',{action:'rehearse',instanceId:first.taskId,previousTaskId:first.taskId,sourceSha:updatedSha,environment:'test-123456789abc'});
    assert.equal(response.status,200,response.text);const plan=response.json();
    assert.deepEqual(plan.plan.applicationSecrets,f.input.applicationSecrets);
    assert.equal((await f.submit(plan)).status,200);const permit=await(await f.machine()).json();assert.equal(permit.secrets.APP_STORAGE_KEY,values.APP_STORAGE_KEY);
    const ns=await f.f.mf.getDurableObjectNamespace('CONNECTIONS'),vault=ns.get(ns.idFromName('connections/v1/'+f.auth.ownerId));
    const snapshot=await vault.inspectApplicationSecrets();assert.equal(snapshot.tasks.length,4);
    assert.deepEqual([...new Set(snapshot.tasks.map(row=>row.task))].sort(),[first.taskId,plan.taskId].sort());
    f.complete(permit);await f.service('service-state',{instanceId:plan.taskId,reconcile:true});
    const cleanup=await f.service('plan',{action:'destroy-preview',instanceId:plan.taskId,previousTaskId:plan.taskId});
    assert.equal(cleanup.status,200,cleanup.text);assert.equal((await f.submit(cleanup.json())).status,200);
    const cleanupPermit=await(await f.machine()).json();assert.equal(cleanupPermit.secrets.APP_STORAGE_KEY,values.APP_STORAGE_KEY);
    assert.equal((await vault.inspectApplicationSecrets()).tasks.length,6);
  }finally{await f.f.close();}
});
