import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { brandFixture } from './brand-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
import { connectedFixture } from './connected-fixture.mjs';

test('brand keys discover accounts atomically, list resources without registration, preserve legacy selection and parent revocation',async()=>{
  const {f,state}=await brandFixture();
  try{
    const token=f.jwt(),headers={'x-csrf-token':(await f.call('/api/admin/state',{token})).json().csrf};
    const call=(body)=>f.call('/api/admin/connections',{token,headers,body});
    const list=(connectionId,kind,cursor='')=>f.call('/api/admin/resources',{token,headers,body:{action:'inventory',connectionId,kind,cursor}});
    const input={action:'connect',id:randomUUID(),name:'生产',provider:'cloudflare',accountId:'',token:fakeToken};
    const result=await call(input);assert.equal(result.status,200,result.text);assert.ok(!result.text.includes(fakeToken));
    const accounts=result.json().connections;assert.equal(accounts.length,2);
    assert.deepEqual((await call(input)).json(),result.json());
    assert.equal((await call({...input,token:fakeToken+'changed'})).status,409);
    for(const kind of ['worker','d1','kv','r2']){const response=await list(accounts[0].id,kind);assert.equal(response.status,200,response.text);assert.equal(response.json().items.length,1);}
    assert.deepEqual((await f.call('/api/admin/resources',{token})).json().resources,[]);
    state.r2Denied=true;assert.equal((await list(accounts[0].id,'r2')).status,409);
    const github=(await call({action:'connect',id:randomUUID(),name:'源码',provider:'github',accountId:'',token:fakeToken})).json().connections[0];assert.equal(github.target,'@owner');
    const repos=await list(github.id,'repository');assert.equal(repos.status,200);assert.equal(repos.json().items.length,3);assert.equal(repos.json().items[1].available,false);assert.equal(repos.json().items[2].reason,'unsupported-name');
    const select={action:'use-repository',id:github.id,revision:1,repository:'owner/repo'};
    const used=await call(select);assert.equal(used.status,200,used.text);assert.equal(used.json().connection.target,'owner/repo');assert.equal((await call(select)).json().connection.id,used.json().connection.id);
    assert.equal((await call({...select,repository:'other/private'})).status,409);
    assert.equal((await call({action:'disable',id:github.id,revision:1})).status,200);
    assert.equal((await call(select)).status,409);
    const snapshot=(await f.call('/api/admin/connections',{token})).json();assert.equal(snapshot.connections.find(row=>row.parentId===github.id).deploymentAvailable,false);
    await f.restart();assert.equal((await f.call('/api/admin/connections')).json().connections.length,4);
  }finally{await f.close();}
});

test('brand inventory and enrollment reject machine identity, missing CSRF, malformed scope and foreign ownership',async()=>{
  const {f,state}=await brandFixture();
  try{
    const token=f.jwt(),headers={'x-csrf-token':(await f.call('/api/admin/state',{token})).json().csrf};
    const body={action:'connect',id:randomUUID(),name:'账户',provider:'github',accountId:'',token:fakeToken};
    assert.equal((await f.call('/api/admin/connections',{token,body})).status,403);
    for(const bad of [{...body,accountId:'owner/repo'},{...body,extra:1},{...body,token:'short'}])assert.equal((await f.call('/api/admin/connections',{token,headers,body:bad})).status,409);
    const saved=(await f.call('/api/admin/connections',{token,headers,body})).json().connections[0];
    const inventory={action:'inventory',connectionId:saved.id,kind:'repository',cursor:''},path='/api/admin/resources';
    assert.equal((await f.call(path,{token:null,headers,body:inventory})).status,403);
    const other=f.jwt({sub:'other-owner'}),otherHeaders={'x-csrf-token':(await f.call('/api/admin/state',{token:other})).json().csrf};
    assert.equal((await f.call(path,{token:other,headers:otherHeaders,body:inventory})).status,409);
    assert.equal((await f.call(path,{token,headers,body:{...inventory,unexpected:1}})).status,409);
    assert.equal((await f.call(path,{token,headers,body:{...inventory,cursor:'https://evil.invalid'}})).status,409);
    state.reject=true;assert.equal((await f.call(path,{token,headers,body:inventory})).status,409);
  }finally{await f.close();}
});

test('brand-selected repository enters the existing exact-SHA deployment and single dispatch contract',async()=>{
  const fixture=await connectedFixture();const {f,session,input,state,preview,submit}=fixture;
  try{
    const connected=await f.call('/api/admin/connections',{...session,body:{action:'connect',id:randomUUID(),name:'GitHub 品牌',provider:'github',accountId:'',token:fakeToken}});
    assert.equal(connected.status,200,connected.text);const account=connected.json().connections[0];
    const selected=await f.call('/api/admin/connections',{...session,body:{action:'use-repository',id:account.id,revision:1,repository:'owner/repo'}});
    assert.equal(selected.status,200,selected.text);const repository=selected.json().connection;
    input.github={id:repository.id,revision:repository.revision};const plan=await preview();assert.equal(plan.plan.application.repository,'owner/repo');
    const result=await submit(plan);assert.equal(result.status,200,result.text);assert.equal(state.dispatches,1);
    assert.equal((await submit(plan)).status,200);assert.equal(state.dispatches,1);
    assert.equal((await f.call('/api/admin/connections',{...session,body:{action:'disable',id:account.id,revision:1}})).status,200);
    assert.equal((await f.call('/api/admin/deployments/plan',{...session,body:input})).status,409);
  }finally{await f.close();}
});

test('brand enrollment is concurrent-idempotent and fails atomically when a multi-account key exceeds capacity',async()=>{
  const {f}=await brandFixture();
  try{
    const token=f.jwt(),headers={'x-csrf-token':(await f.call('/api/admin/state',{token})).json().csrf};
    const call=body=>f.call('/api/admin/connections',{token,headers,body});
    const batch={action:'connect',id:randomUUID(),name:'多账户',provider:'cloudflare',accountId:'',token:fakeToken};
    const parallel=await Promise.all([call(batch),call(batch)]);assert.ok(parallel.every(r=>r.status===200));assert.deepEqual(parallel[0].json(),parallel[1].json());
    for(let i=0;i<29;i++)assert.equal((await call({action:'create',id:randomUUID(),name:'旧连接 '+i,provider:'cloudflare',target:'a'.repeat(32),token:fakeToken})).status,200);
    assert.equal((await call({...batch,id:randomUUID()})).status,409);assert.equal((await f.call('/api/admin/connections',{token})).json().connections.length,31);
    const final=await Promise.all([1,2].map(()=>call({...batch,id:randomUUID(),accountId:'a'.repeat(32)})));assert.deepEqual(final.map(r=>r.status).sort(),[200,409]);
    assert.equal((await f.call('/api/admin/connections',{token})).json().connections.length,32);
  }finally{await f.close();}
});
