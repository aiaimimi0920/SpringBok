import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedFixture } from './connected-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';

test('independent exact-release verify preserves unknown receipt and claims, grants no deployment secrets, and survives restart',async()=>{
  const {f,state,api,preview,submit,machine,receipt,session}=await connectedFixture();
  try{
    const plan=await preview();assert.equal((await submit(plan)).status,200);
    const originalRequest=structuredClone(state.request);
    receipt(await(await machine()).json(),'unknown',{errorCode:'NACCOUNT_READINESS_FAILED'});
    const original=(await api('reconcile',{taskId:plan.taskId})).json();assert.equal(original.job.status,'unknown');
    const body={instanceId:plan.taskId,previousTaskId:plan.taskId};
    assert.equal((await f.call('/api/admin/deployments/verify',{token:session.token,body})).status,403);
    assert.equal((await f.call('/api/admin/deployments/verify',{...session,token:f.jwt({sub:'foreign'}),body})).status,403);
    assert.equal((await api('verify',{...body,previousTaskId:'dc-'+'a'.repeat(32)})).status,409);
    state.runStatus='in_progress';
    const [one,two]=await Promise.all([api('verify',body),api('verify',body)]);assert.equal(one.status,200);assert.equal(two.status,200);
    assert.equal(state.dispatches,2);assert.equal(state.request.action,'verify');
    assert.equal(state.request.sourceSha,originalRequest.sourceSha);assert.deepEqual(state.request.configuration,originalRequest.configuration);
    const verifyId=state.request.taskId;assert.notEqual(verifyId,plan.taskId);
    const permit=await(await machine()).json();assert.deepEqual(permit.secrets,{CLOUDFLARE_API_TOKEN:'verification-not-applicable'});assert.ok(!JSON.stringify(permit).includes(fakeToken));
    assert.equal((await machine()).status,403);
    receipt(permit);const ready=(await api('service-state',{instanceId:plan.taskId,reconcile:true})).json();
    assert.equal(ready.verification.status,'succeeded');assert.deepEqual(ready.job,original.job);assert.equal(ready.canUpdate,false);assert.equal(ready.canDelete,false);
    assert.equal(ready.verification.job.request.action,'verify');assert.equal(ready.canVerify,false);
    await f.restart();const restored=(await api('service-state',{instanceId:plan.taskId,reconcile:false})).json();assert.equal(restored.verification.status,'succeeded');assert.deepEqual(restored.job,original.job);
    assert.equal((await api('verify',body)).status,200);assert.equal(state.dispatches,2);
    const index=(await f.call('/api/admin/deployments/services',session)).json();assert.equal(index.services.length,1);assert.equal(index.services[0].taskId,plan.taskId);
  }finally{await f.close();}
});

test('failed verification does not promote unknown and active deployment cannot start verification',async()=>{
  const {f,state,api,preview,submit,machine,receipt}=await connectedFixture();
  try{
    const plan=await preview();assert.equal((await submit(plan)).status,200);
    const body={instanceId:plan.taskId,previousTaskId:plan.taskId};assert.equal((await api('verify',body)).status,409);
    receipt(await(await machine()).json(),'unknown');await api('reconcile',{taskId:plan.taskId});
    state.runStatus='in_progress';assert.equal((await api('verify',body)).status,200);
    receipt(await(await machine()).json(),'failed',{errorCode:'VERIFY_NOT_READY'});
    const result=(await api('service-state',{instanceId:plan.taskId,reconcile:true})).json();
    assert.equal(result.job.status,'unknown');assert.equal(result.verification.status,'failed');assert.equal(result.canUpdate,false);assert.equal(result.canDelete,false);
  }finally{await f.close();}
});
