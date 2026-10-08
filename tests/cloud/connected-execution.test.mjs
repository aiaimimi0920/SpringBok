import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedFixture } from './connected-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
import { randomUUID } from 'node:crypto';
const nextTask=()=>`dc-${randomUUID().replaceAll('-','')}`;
test('new executor can submit, obtain its own permit and settle an exact receipt',async()=>{
  const {f,preview,submit,machine,receipt,api}=await connectedFixture();try{
    const next='9'.repeat(40);f.bindings.SBA_CONNECTED_EXECUTOR_SHA=next;await f.restart();
    const plan=await preview(),submitted=await submit(plan);assert.equal(submitted.status,200,submitted.text);
    const permit=await machine();assert.equal(permit.status,200);
    receipt(await permit.json());assert.equal((await api('reconcile',{taskId:plan.taskId})).json().job.status,'succeeded');
  }finally{await f.close();}
});
test('connected executor release pins new drafts without rewriting legacy or in-flight authority',async()=>{
  const {f,session,preview,submit,machine,receipt,api,post,input,state}=await connectedFixture();try{
    const old=await preview(),legacy=(await f.call('/api/admin/sba/state',session)).json();
    assert.equal((await submit(old)).status,200);
    const next='9'.repeat(40);f.bindings.SBA_CONNECTED_EXECUTOR_SHA=next;await f.restart();
    const fresh=await preview();
    assert.equal(fresh.plan.policy.github.executorSha,next);
    assert.equal(fresh.plan.policy.github.ref,`sba-executor-${next}`);
    assert.notEqual(fresh.plan.digest,old.plan.digest);
    assert.deepEqual((await f.call('/api/admin/sba/state',session)).json(),legacy);
    assert.equal((await api('state',{taskId:old.taskId})).status,200);
    const permit=await machine();assert.equal(permit.status,200);receipt(await permit.json());
    assert.equal((await api('reconcile',{taskId:old.taskId})).json().job.status,'succeeded');
    assert.equal(state.dispatches,1);
    f.bindings.SBA_CONNECTED_EXECUTOR_SHA='main';await f.restart();
    assert.equal((await post(input)).status,409);
  }finally{await f.close();}
});
test('executor release invalidates an unsubmitted old draft without dispatch',async()=>{
  const {f,preview,submit,state}=await connectedFixture();try{
    const old=await preview();f.bindings.SBA_CONNECTED_EXECUTOR_SHA='9'.repeat(40);await f.restart();
    assert.equal((await submit(old)).status,409);assert.equal(state.dispatches,0);
  }finally{await f.close();}
});
test('account lane serializes owners and retains claimed resources and environments after successful release',async()=>{
  const {f}=await connectedFixture();try{
    const ns=await f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'),stub=ns.get(ns.idFromName('deployment-account/v1/'+'a'.repeat(32))),one=nextTask(),two=nextTask();
    const claim=(owner,task,scope,keys)=>stub.claim(owner,task,'a'.repeat(32),scope,keys,'c'.repeat(64));
    await claim('1'.repeat(64),one,'owner/repo/first',['d1:one']);await assert.rejects(claim('2'.repeat(64),two,'other/repo/second',['d1:two']));
    await stub.release(one);await assert.rejects(claim('2'.repeat(64),two,'owner/repo/first',['d1:two']));await assert.rejects(claim('2'.repeat(64),two,'other/repo/second',['d1:one']));
    await claim('2'.repeat(64),two,'other/repo/second',['d1:two']);await f.restart();
    const restarted=(await f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'));await assert.rejects(restarted.get(restarted.idFromName('deployment-account/v1/'+'a'.repeat(32))).claim('3'.repeat(64),nextTask(),'a'.repeat(32),'new/repo/test',[],'c'.repeat(64)));
  }finally{await f.close();}
});
test('bootstrap is immutable, owner-bound and does not inherit legacy recovery; disabling execution blocks new permits',async()=>{
  const {f,auth,session,preview,submit,machine,api}=await connectedFixture();try{
    const plan=await preview();await submit(plan);const ns=await f.mf.getDurableObjectNamespace('CONNECTED_TASKS'),stub=ns.get(ns.idFromName('connected/v1/'+plan.taskId));
    await assert.rejects(stub.bootstrap('1'.repeat(64)));await assert.rejects(stub.initialize(auth.ownerId,plan.taskId,{...plan.plan,digest:'1'.repeat(64)}));await assert.rejects(stub.recoverUnstarted());
    const otherToken=f.jwt({sub:'other-owner'}),other=(await f.call('/api/admin/state',{token:otherToken})).json();
    assert.equal((await f.call('/api/admin/deployments/state',{token:otherToken,headers:{'x-csrf-token':other.csrf},body:{taskId:plan.taskId}})).status,409);
    assert.equal((await f.call('/api/admin/deployments',{token:otherToken})).json().tasks.length,0);
    f.bindings.ENABLE_CONNECTED_DEPLOYMENTS='no';await f.restart();assert.equal((await machine()).status,403);assert.equal((await api('state',{taskId:plan.taskId})).status,200);
    assert.equal((await f.call('/api/admin/sba/state',session)).json().job,null);
  }finally{await f.close();}
});
test('connected deployment isolates old SBA, dispatches once and recovers exact one-time receipt after restart',async()=>{
  const {f,state,session,api,preview,submit,machine,receipt}=await connectedFixture();try{
    const plan=await preview();assert.equal(plan.executionEnabled,true);
    const results=await Promise.all([submit(plan),submit(plan)]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(state.dispatches,1);
    assert.equal((await f.call('/api/admin/sba/state',session)).json().job,null);
    assert.equal((await machine('source')).status,200);assert.equal((await machine('source')).status,200);
    const response=await machine();assert.equal(response.status,200);const permit=await response.json();assert.equal(permit.secrets.CLOUDFLARE_API_TOKEN,fakeToken);
    assert.equal((await machine()).status,403);assert.equal((await machine('source')).status,403);await f.restart();
    receipt(permit);const reconciled=await api('reconcile',{taskId:plan.taskId});assert.equal(reconciled.status,200,reconciled.text);assert.equal(reconciled.json().job.status,'succeeded');assert.ok(!reconciled.text.includes(fakeToken));
    assert.equal((await f.call('/api/admin/deployments',session)).json().tasks[0].taskId,plan.taskId);
    assert.equal((await submit(await preview())).status,409);assert.equal(state.dispatches,1);
  }finally{await f.close();}
});
test('new task rejects forged plans, stale refs, disabled connections and cross-owner reads',async()=>{
  const {f,session,input,preview,submit,api}=await connectedFixture();try{
    const plan=await preview();const changed=structuredClone(plan);changed.plan.policy.configuration.database.id='forged';assert.equal((await submit(changed)).status,409);
    assert.equal((await api('state',{taskId:plan.taskId})).status,409);
    await f.call('/api/admin/connections',{...session,body:{action:'disable',...input.cloudflare}});assert.equal((await submit(plan)).status,409);
  }finally{await f.close();}
});
test('final configuration cannot hide legacy targets or resources in undeclared fields',async()=>{
  const {f,state,input,preview,submit}=await connectedFixture();try{
    const policy=JSON.parse(f.bindings.SBA_POLICY);policy.configuration={server:{name:'legacy-worker',url:'https://legacy.example.invalid'},database:{id:'12345678-1234-1234-1234-000000000000'},kvId:'b'.repeat(32)};f.bindings.SBA_POLICY=JSON.stringify(policy);await f.restart();
    state.declaration={...state.declaration,resources:[]};input.resources={};input.values['server.name']='legacy-worker';assert.equal((await submit(await preview())).status,409);
    input.values['server.name']='different-worker';for(const value of ['https://legacy.example.invalid','12345678-1234-1234-1234-000000000000','b'.repeat(32)]){input.values.vars={nested:{undeclared:value}};assert.equal((await submit(await preview())).status,409);}
    assert.equal(state.dispatches,0);
  }finally{await f.close();}
});
test('successful first deployment reserves Worker identity across changed environments and resource declarations',async()=>{
  const {f,state,input,preview,submit,machine,receipt,api}=await connectedFixture();try{
    const plan=await preview();await submit(plan);receipt(await (await machine()).json());assert.equal((await api('reconcile',{taskId:plan.taskId})).json().job.status,'succeeded');
    state.declaration={...state.declaration,resources:[]};input.resources={};input.environment='another-environment';const blocked=await preview();assert.equal((await submit(blocked)).status,409);assert.equal(state.dispatches,1);assert.equal((await api('state',{taskId:blocked.taskId})).json().status,'preparation-unconfirmed');
  }finally{await f.close();}
});
test('dispatch uncertainty cannot replay; approved in-flight connection disable does not erase authority',async()=>{
  const {f,state,session,input,preview,submit,machine,api,receipt}=await connectedFixture();try{
    const plan=await preview();state.dispatchLost=true;assert.equal((await submit(plan)).json().job.status,'dispatch-unknown');assert.equal((await submit(plan)).status,200);assert.equal(state.dispatches,1);
    await f.call('/api/admin/connections',{...session,body:{action:'disable',...input.cloudflare}});
    const permit=await machine();assert.equal(permit.status,200);receipt(await permit.json(),'unknown');const result=await api('reconcile',{taskId:plan.taskId});assert.equal(result.json().job.status,'unknown');
    assert.equal((await machine()).status,403);assert.equal((await api('reconcile',{taskId:plan.taskId})).json().job.status,'unknown');assert.equal(state.dispatches,1);
  }finally{await f.close();}
});
test('machine bootstrap, OIDC, digest, browser context and exact GitHub run all fail closed',async()=>{
  const {f,state,preview,submit,machine,token}=await connectedFixture();try{
    const plan=await preview();await submit(plan);
    for(const extra of [{body:JSON.stringify({taskId:plan.taskId,requestDigest:'0'.repeat(64)})},{body:JSON.stringify({taskId:'dc-'+'1'.repeat(32),requestDigest:state.digest})},{headers:{authorization:`Bearer ${token({run_attempt:'2'})}`,'content-type':'application/json'}},{headers:{authorization:`Bearer ${token()}`,'content-type':'application/json',origin:'https://evil.invalid'}}])assert.equal((await machine('permit',extra)).status,403);
    state.badTitle=true;assert.equal((await machine()).status,403);state.badTitle=false;assert.equal((await machine()).status,200);
  }finally{await f.close();}
});
