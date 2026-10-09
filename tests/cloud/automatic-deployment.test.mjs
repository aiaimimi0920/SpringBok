import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectedFixture } from './connected-fixture.mjs';
import { declaration } from './deployment-fixture.mjs';
import { manifest } from './sba-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
import { deploymentDeclaration, automaticConfiguration } from '../../cloud/deployment-contract.mjs';
import { importComponents } from '../../cloud/service-import.mjs';

const accountA='a'.repeat(32),accountB='b'.repeat(32),databaseId='87654321-1234-1234-1234-123456789abc';
export const automaticDeclaration=()=>({...structuredClone(declaration),schemaVersion:2,accountMode:'single',
  accounts:[{key:'runtime',label:'账户',path:['accountId'],secret:'CLOUDFLARE_API_TOKEN'}],
  fields:declaration.fields.map(field=>({...field,template:field.type==='text'?'{instance}-worker':null})),
  resources:declaration.resources.map(row=>({...row,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-db'})),
  targets:declaration.targets.map(target=>({...target,account:'runtime'}))});

async function automaticFixture(multiple=false){
  const fixture=await connectedFixture(),{state,input,f,session}=fixture,provider=state.provider;
  state.resources=null;state.declaration=automaticDeclaration();state.creates=[];state.failKind=null;
  input.values={};input.resources={};
  state.provider=async(request,context)=>{
    const url=new URL(request.url);
    if(url.origin==='https://api.cloudflare.com'){
      const second=url.pathname.includes(accountB),token=second?'synthetic-second-account-token':fakeToken;
      assert.equal(request.headers.get('authorization'),'Bearer '+token);
      if(url.pathname.endsWith(accountB))return Response.json({success:true,result:{id:accountB}});
      if(request.method==='POST'){
        const body=await request.json();state.creates.push({url:request.url,body});
        if(state.failKind&&url.pathname.endsWith(state.failKind))return Response.json({error:token},{status:503});
        if(url.pathname.endsWith('/d1/database'))return Response.json({success:true,result:{uuid:databaseId,name:body.name}});
        if(url.pathname.endsWith('/storage/kv/namespaces'))return Response.json({success:true,result:{id:'c'.repeat(32),title:body.title}});
        if(url.pathname.endsWith('/r2/buckets'))return Response.json({success:true,result:{name:body.name}});
      }
      if(url.pathname.endsWith('/workers/subdomain'))return Response.json({success:true,result:{subdomain:'synthetic-test'}});
    }
    return provider(request,context);
  };
  if(multiple){
    const id=randomUUID();assert.equal((await f.call('/api/admin/connections',{...session,body:{action:'create',id,name:'storage',provider:'cloudflare',target:accountB,token:'synthetic-second-account-token'}})).status,200);
    state.declaration.accountMode='multiple';state.declaration.accounts.push({key:'storage',label:'存储账户',path:['storageAccountId'],secret:'STORAGE_API_TOKEN'});
    state.declaration.resources.push({key:'session',label:'缓存',kind:'kv',idPath:['kvId'],namePath:null,account:'storage',nativeAccount:null,nameTemplate:'{instance}-kv'});
    state.manifest={...manifest,secrets:['CLOUDFLARE_API_TOKEN','STORAGE_API_TOKEN']};input.accounts={storage:{id,revision:1}};
  }
  return fixture;
}

async function domainFixture(){
  const fixture=await automaticFixture(),{f,state,input,session}=fixture,provider=state.provider;
  const zoneId='d'.repeat(32);state.zoneAccount=accountA;state.zoneStatus='active';state.dnsOccupied=false;state.zoneReads=0;
  state.declaration.fields.push({path:['server','url'],label:'地址',type:'text',required:true,template:'https://{instance}.{subdomain:runtime}.workers.dev'});
  state.declaration.targets.push({kind:'domain',path:['server','url'],account:'runtime'});
  state.provider=async(request,context)=>{
    const url=new URL(request.url),zone={id:zoneId,name:'example.com',account:{id:state.zoneAccount},status:state.zoneStatus};
    if(url.origin==='https://api.cloudflare.com'&&url.pathname.startsWith('/client/v4/zones')){
      assert.equal(request.method,'GET');state.zoneReads++;
      if(url.pathname.endsWith('/dns_records'))return Response.json({success:true,result:state.dnsOccupied?[{id:'existing'}]:[],result_info:{total_count:state.dnsOccupied?1:0}});
      return Response.json({success:true,result:url.pathname.endsWith('/zones')?[zone]:zone});
    }
    return provider(request,context);
  };
  const listing=await f.call('/api/admin/resources',{...session,body:{action:'discover',connectionId:input.cloudflare.id,kind:'zone',cursor:''}});assert.equal(listing.status,200);
  const saved=await f.call('/api/admin/resources',{...session,body:{action:'register',connectionId:input.cloudflare.id,kind:'zone',listingId:listing.json().id,resourceId:zoneId}});assert.equal(saved.status,200);
  const resource=saved.json().resource;
  input.domains={'server.url':{resource:{id:resource.id,revision:resource.revision},subdomain:'accounts'}};
  return fixture;
}
test('administrator profiles isolate encrypted defaults and overrides from public plans and preserve the single permit',async()=>{
  const {f,state,input,session,preview,submit,machine,api,auth}=await automaticFixture();
  const defaultValue='Synthetic-default-Only!42',overrideValue='Synthetic-override-Only!43';
  try{
    state.declaration.administrator={emailPath:['admin','bootstrapEmail'],secret:'ADMIN_BOOTSTRAP_PASSWORD'};
    state.manifest={...manifest,secrets:['CLOUDFLARE_API_TOKEN','ADMIN_BOOTSTRAP_PASSWORD']};
    const body={action:'admin-profile',id:randomUUID(),email:'fixture@gmail.com',password:defaultValue};
    assert.equal((await f.call('/api/admin/resources',{token:session.token,body})).status,403);
    const saved=await f.call('/api/admin/resources',{...session,body});assert.equal(saved.status,200);assert.ok(!saved.text.includes(defaultValue));
    const profile={id:body.id,revision:1};input.administrator={profile};
    let plan=await preview();assert.equal(plan.plan.configuration.admin.bootstrapEmail,body.email);assert.ok(!JSON.stringify(plan).includes(defaultValue));
    const override=await f.call('/api/admin/resources',{...session,body:{action:'admin-override',id:randomUUID(),profile,password:overrideValue}});assert.equal(override.status,200);
    input.administrator.override={id:override.json().profile.id,revision:1};
    plan=await preview();assert.ok(!JSON.stringify(plan).includes(overrideValue));
    assert.equal((await api('plan',{...input,administrator:{profile:{...profile,revision:999}}})).status,409);
    await f.restart();const snapshot=await f.call('/api/admin/resources',session);assert.equal(snapshot.json().adminProfiles.length,1);assert.ok(!snapshot.text.includes(defaultValue)&&!snapshot.text.includes(overrideValue));
    const foreign=await f.call('/api/admin/resources',{token:f.jwt({sub:'foreign'})});assert.equal(foreign.json().adminProfiles.length,0);
    assert.equal((await submit(plan)).status,200);assert.equal(state.dispatches,1);
    const ns=await f.mf.getDurableObjectNamespace('CONNECTIONS'),vault=ns.get(ns.idFromName('connections/v1/'+auth.ownerId));
    await vault.expireAdminOverrides();assert.equal((await api('plan',input)).status,409);
    const replacement=await f.call('/api/admin/resources',{...session,body:{action:'admin-override',id:randomUUID(),profile,password:'Synthetic-Replacement!44'}});
    assert.equal(replacement.status,200);assert.equal(await vault.adminProfileCount(),2);
    const permit=await(await machine()).json();assert.equal(permit.secrets.ADMIN_BOOTSTRAP_PASSWORD,overrideValue);
    assert.equal((await machine()).status,403);
    assert.ok(!JSON.stringify(state.request).includes(defaultValue)&&!JSON.stringify(state.request).includes(overrideValue));
    const listing=await f.call('/api/admin/deployments/services',session);assert.ok(!listing.text.includes(defaultValue)&&!listing.text.includes(overrideValue));
  }finally{await f.close();}
});
test('administrator declaration absent or unselected never grants stored passwords',async()=>{
  const {f,state,input,preview,submit,machine,api}=await automaticFixture();
  try{
    assert.equal((await api('plan',{...input,administrator:{profile:{id:randomUUID(),revision:1}}})).status,409);
    state.declaration.administrator={emailPath:['admin','bootstrapEmail'],secret:'ADMIN_BOOTSTRAP_PASSWORD'};
    state.manifest={...manifest,secrets:['CLOUDFLARE_API_TOKEN','ADMIN_BOOTSTRAP_PASSWORD']};
    const plan=await preview();assert.equal(plan.plan.configuration.admin,undefined);
    assert.equal((await submit(plan)).status,200);assert.equal((await(await machine()).json()).secrets.ADMIN_BOOTSTRAP_PASSWORD,'bootstrap-not-applicable');
  }finally{await f.close();}
});
test('selected Zone resolves a signed subdomain, is rechecked at submit and never becomes an owned data resource',async()=>{
  const {f,state,preview,submit,machine}=await domainFixture();
  try{
    const plan=await preview();assert.equal(plan.plan.configuration.server.url,'https://accounts.example.com');assert.equal(state.creates.length,0);
    assert.equal(Object.values(plan.plan.resources).some(row=>row.kind==='zone'),false);
    const reads=state.zoneReads;assert.equal((await submit(plan)).status,200);assert.ok(state.zoneReads>reads);
    assert.equal(state.request.configuration.server.url,'https://accounts.example.com');assert.equal(state.dispatches,1);
    const permit=await(await machine()).json();assert.deepEqual(permit.secrets,{CLOUDFLARE_API_TOKEN:fakeToken});
    await f.restart();assert.equal((await submit(plan)).status,200);assert.equal(state.dispatches,1);
  }finally{await f.close();}
});
test('Zone ownership/status/DNS drift, arbitrary suffix and forged registration reject before any provisioning',async()=>{
  const {f,state,input,preview,submit,api}=await domainFixture();
  try{
    const plan=await preview();state.dnsOccupied=true;assert.equal((await submit(plan)).status,409);assert.equal(state.creates.length,0);state.dnsOccupied=false;
    for(const [key,value] of [['zoneStatus','pending'],['zoneAccount',accountB]]){const old=state[key];state[key]=value;assert.equal((await api('plan',input)).status,409);state[key]=old;}
    const selected=input.domains['server.url'];
    for(const subdomain of ['other.example.net','../evil','-bad','bad-','a'.repeat(64)]){assert.equal((await api('plan',{...input,domains:{'server.url':{...selected,subdomain}}})).status,409);}
    assert.equal((await api('plan',{...input,domains:{'server.url':{...selected,resource:{...selected.resource,revision:999}}}})).status,409);
    assert.equal(state.creates.length,0);assert.equal(state.dispatches,0);
  }finally{await f.close();}
});

test('automatic declaration preserves v1 and rejects invalid account topology and native cross-account binding',()=>{
  assert.equal(deploymentDeclaration(declaration).schemaVersion,1);
  const d=automaticDeclaration();assert.equal(deploymentDeclaration(d).schemaVersion,2);
  const invalid=structuredClone(d);invalid.accounts.push({...invalid.accounts[0],key:'other'});assert.throws(()=>deploymentDeclaration(invalid));
  d.accountMode='multiple';d.accounts.push({key:'storage',label:'存储',path:['storageId'],secret:'STORAGE_API_TOKEN'});d.resources[0].account='storage';
  assert.throws(()=>importComponents({declaration:d}),'single-account import must not fabricate multi-account provenance');
  assert.throws(()=>automaticConfiguration(d,{}, {database:{kind:'d1',accountId:accountB,remoteId:null,name:'testing-db'}},{runtime:{accountId:accountA},storage:{accountId:accountB}},'testing'));
});
test('automatic create persists generated IDs, dispatches once, grants exact account credentials and survives restart',async()=>{
  const {f,state,preview,submit,machine,receipt,api,session}=await automaticFixture(true);
  try{
    const plan=await preview();assert.equal(state.creates.length,0);assert.equal(plan.plan.configuration.database.id,null);
    const results=await Promise.all([submit(plan),submit(plan)]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
    assert.equal(state.creates.length,2);assert.equal(state.dispatches,1);
    assert.equal(state.request.configuration.database.id,databaseId);assert.equal(state.request.configuration.kvId,'c'.repeat(32));assert.equal(state.request.configuration.storageAccountId,accountB);
    const permit=await (await machine()).json();assert.deepEqual(permit.secrets,{CLOUDFLARE_API_TOKEN:fakeToken,STORAGE_API_TOKEN:'synthetic-second-account-token'});
    await f.restart();assert.equal((await submit(plan)).status,200);assert.equal(state.creates.length,2);
    receipt(permit);assert.equal((await api('reconcile',{taskId:plan.taskId})).json().job.status,'succeeded');
    const listing=await f.call('/api/admin/deployments/services',session);assert.ok(!listing.text.includes(fakeToken));assert.equal(listing.json().services[0].summary.resources.database.remoteId,databaseId);
    const ns=await f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    // Both successful lanes release, but created IDs remain reserved across task names.
    for(const [account,id] of [[accountA,databaseId],[accountB,'c'.repeat(32)]]){
      const lock=ns.get(ns.idFromName('deployment-account/v1/'+account));
      await assert.rejects(lock.claim('1'.repeat(64),'dc-'+randomUUID().replaceAll('-',''),account,'other/repo/env',['identity:'+id],'d'.repeat(64)));
      await lock.claim('1'.repeat(64),'dc-'+randomUUID().replaceAll('-',''),account,'other/repo/env',[],'d'.repeat(64));
    }
    assert.equal(state.dispatches,1);
  }finally{await f.close();}
});
test('a second-account lock conflict prevents every resource write, including after restart',async()=>{
  const {f,state,preview,submit}=await automaticFixture(true);
  try{
    const ns=await f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'),lock=ns.get(ns.idFromName('deployment-account/v1/'+accountB));
    await lock.claim('1'.repeat(64),'dc-'+randomUUID().replaceAll('-',''),accountB,'different/repo/env',[],'d'.repeat(64));
    const plan=await preview();assert.equal((await submit(plan)).status,409);assert.equal(state.creates.length,0);assert.equal(state.dispatches,0);
    await f.restart();assert.equal((await submit(plan)).status,200);assert.equal(state.creates.length,0);assert.equal(state.dispatches,0);
  }finally{await f.close();}
});
test('resource-only subdomain templates and R2 creation use verified provider facts',async()=>{
  const {f,state,preview,submit}=await automaticFixture();
  try{
    state.declaration.resources[0]={key:'bucket',label:'对象存储',kind:'r2',idPath:['bucket'],namePath:null,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-{subdomain:runtime}'};
    const plan=await preview();assert.equal(plan.plan.resources.bucket.name,'testing-synthetic-test');
    assert.equal((await submit(plan)).status,200);assert.equal(state.creates.length,1);assert.equal(state.request.configuration.bucket,'testing-synthetic-test');
  }finally{await f.close();}
});
test('resource capacity is reserved before any provider mutation',async()=>{
  const {f,state,preview,submit,auth}=await automaticFixture(true);
  try{
    const ns=await f.mf.getDurableObjectNamespace('CONNECTIONS'),vault=ns.get(ns.idFromName('connections/v1/'+auth.ownerId));
    await vault.fillResourceCapacity(127);const plan=await preview();assert.equal((await submit(plan)).status,409);
    assert.equal(state.creates.length,0);assert.equal(state.dispatches,0);
  }finally{await f.close();}
});
test('partial creation remains unknown across duplicate submits and restart with successful resources retained',async()=>{
  const {f,state,preview,submit,api}=await automaticFixture(true);
  try{
    state.failKind='/storage/kv/namespaces';const plan=await preview();assert.equal((await submit(plan)).status,409);
    assert.equal(state.creates.length,2);assert.equal(state.dispatches,0);
    await f.restart();const snapshot=(await api('state',{taskId:plan.taskId})).json();
    assert.equal(snapshot.errorCode,'RESOURCE_CREATION_UNCONFIRMED');assert.equal(snapshot.preparation.resources.database.status,'created');assert.equal(snapshot.preparation.resources.session.status,'unknown');
    assert.equal(snapshot.preparation.resources.database.resource.remoteId,databaseId);
    assert.equal((await submit(plan)).status,200);assert.equal(state.creates.length,2);assert.equal(state.dispatches,0);
    assert.ok(!JSON.stringify(snapshot).includes('synthetic-second-account-token'));
  }finally{await f.close();}
});
test('automatic subdomain defaults are provider-derived and disabled source cannot start creation',async()=>{
  const {f,state,input,preview,submit,session}=await automaticFixture();
  try{
    state.declaration.fields.push({path:['url'],label:'网址',type:'text',required:true,template:'https://{instance}-worker.{subdomain:runtime}.workers.dev'});
    state.declaration.targets.push({kind:'domain',path:['url'],account:'runtime'});
    const plan=await preview();assert.equal(plan.plan.configuration.url,'https://testing-worker.synthetic-test.workers.dev');
    await f.call('/api/admin/connections',{...session,body:{action:'disable',...input.cloudflare}});
    assert.equal((await submit(plan)).status,409);assert.equal(state.creates.length,0);assert.equal(state.dispatches,0);
  }finally{await f.close();}
});
