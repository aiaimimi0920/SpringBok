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
