import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionsFixture, fakeToken } from './connections-fixture.mjs';
const path='/api/admin/resources', remoteId='12345678-1234-1234-1234-123456789abc';
async function setup(overrides={}) {
  const {f,state}=await connectionsFixture(overrides), token=f.jwt(), result=await f.call('/api/admin/state',{token});
  const session={token,headers:{'x-csrf-token':result.json().csrf}}, owner=result.json().ownerId, id=randomUUID();
  const created=await f.call('/api/admin/connections',{...session,body:{action:'create',id,name:'资源连接',provider:'cloudflare',target:'a'.repeat(32),token:fakeToken}});assert.equal(created.status,200);
  state.resources={success:true,result:[{uuid:remoteId,name:'已有数据库'}]};
  const discover={action:'discover',connectionId:id,kind:'d1',cursor:''};
  const post=async(body,status=200)=>{const r=await f.call(path,{...session,body});assert.equal(r.status,status,r.text);assert.ok(!r.text.includes(fakeToken));return r.json();};
  const ns=await f.mf.getDurableObjectNamespace('CONNECTIONS'), stub=ns.get(ns.idFromName(`connections/v1/${owner}`));
  return {f,state,session,owner,id,discover,post,stub};
}
const registration=listing=>({action:'register',connectionId:listing.connectionId,kind:listing.kind,listingId:listing.id,resourceId:listing.items[0].id});
test('older discovery cannot overwrite a newer successful or failed discovery',async()=>{
  for(const reject of [false,true]){
    const {f,state,session,discover,post}=await setup();let release;try{
      const first=await post(discover);state.hold=new Promise(resolve=>{release=resolve;});let started;const observed=new Promise(resolve=>{started=resolve;});state.onRequest=started;
      const older=f.call(path,{...session,body:discover});await observed;state.hold=null;state.onRequest=null;state.reject=reject;
      const newer=await post(discover,reject?409:200);state.reject=false;release();assert.equal((await older).status,409);
      if(reject)await post(registration(first),409);else await post(registration(newer));
    }finally{release?.();await f.close();}
  }
});
test('resource capacity is bounded and existing registrations remain idempotent',async()=>{
  const {f,state,discover,post}=await setup();try{
    let first;
    for(let page=0;page<2;page++){
      state.resources={success:true,result:Array.from({length:page?29:100},(_,i)=>({uuid:`12345678-1234-1234-1234-${String(page*100+i).padStart(12,'0')}`,name:'db'}))};
      const listing=await post(discover);for(let i=0;i<listing.items.length;i++){
        const body={...registration(listing),resourceId:listing.items[i].id};await post(body,page===1&&i===28?409:200);first??=body;
      }
    }
    await post(first,409);
  }finally{await f.close();}
});
test('resources register only observed IDs, deduplicate and persist without cloud mutations',async()=>{
  const {f,state,session,discover,post}=await setup();try{
    const listing=await post(discover), body=registration(listing);
    await post({...body,resourceId:'00000000-0000-0000-0000-000000000000'},409);
    const first=await post(body);assert.deepEqual(await post(body),first);
    await f.restart();const snapshot=(await f.call(path,session)).json();assert.equal(snapshot.resources.length,1);assert.equal(snapshot.resources[0].available,true);
    assert.equal(snapshot.resources[0].remoteId,remoteId);assert.ok(state.requests.every(r=>r.method==='GET'));
    assert.equal((await f.call(path,{token:f.jwt({sub:'other-owner'})})).json().resources.length,0);
    assert.equal((await f.call('/api/admin/state',session)).json().jobs.length,0);
  }finally{await f.close();}
});
test('resources enforce access, CSRF, owner, feature gate and safe navigation',async()=>{
  const {f,session,discover,post,stub}=await setup();try{
    for(const route of [path,'/resources','/resources.js']) assert.equal((await f.call(route,{token:null})).status,403);
    assert.equal((await f.call('/resources',{headers:{'sec-fetch-site':'cross-site'}})).status,200);
    assert.equal((await f.call(path,{body:discover})).status,403);
    assert.equal((await f.call(path,{...session,headers:{...session.headers,origin:'https://evil.invalid'},body:discover})).status,403);
    await post({...discover,owner:'forged'},409);await assert.rejects(stub.resourceSnapshot('other-owner'));
    f.bindings.ENABLE_CONNECTIONS='no';await f.restart();assert.equal((await f.call(path,session)).status,503);
  }finally{await f.close();}
});
test('stale listings, failed refresh and partial resource storage fail closed',async()=>{
  const {f,state,discover,post,stub,session}=await setup();try{
    const first=await post(discover);await post(discover);await post(registration(first),409);
    const second=await post(discover);await stub.expireListing();await post(registration(second),409);
    const third=await post(discover);state.reject=true;await post(discover,409);await post(registration(third),409);
    await stub.breakStorage('resources');assert.equal((await f.call(path,session)).status,409);
  }finally{await f.close();}
});
test('connection revision changes invalidate registered resources and in-flight discovery',async()=>{
  const {f,state,session,id,discover,post}=await setup();let release;try{
    const listing=await post(discover);await post(registration(listing));
    state.hold=new Promise(resolve=>{release=resolve;});let started;const observed=new Promise(resolve=>{started=resolve;});state.onRequest=started;
    const pending=f.call(path,{...session,body:discover});await observed;
    assert.equal((await f.call('/api/admin/connections',{...session,body:{action:'disable',id,revision:1}})).status,200);
    release();assert.equal((await pending).status,409);await post(registration(listing),409);
    assert.equal((await f.call(path,session)).json().resources[0].available,false);
  }finally{release?.();await f.close();}
});
