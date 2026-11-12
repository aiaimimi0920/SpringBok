import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, updatedSha } from './service-fixture.mjs';

test('authenticated late receipt resolves observation without rewriting deadline history or replaying execution',async()=>{
  const x=await serviceFixture(),{f,service,input,github,submit,machine,receipt,state}=x;
  try {
    const first=(await service('plan',{...input,github,repository:'owner/repo'})).json();
    await submit(first);const permit=await(await machine()).json();
    const owner=(await f.call('/api/admin/state')).json().ownerId;
    const ns=await f.mf.getDurableObjectNamespace('CONNECTED_TASKS'),stub=ns.get(ns.idFromName('connected/v1/'+first.taskId));
    await stub.expireResult();
    const body={instanceId:first.taskId,reconcile:false};
    assert.equal((await service('service-state',body)).json().job.errorCode,'SBA_TASK_DEADLINE');
    const original=await stub.rawJob();
    assert.equal((await service('service-state',{...body,reconcile:true})).json().canUpdate,false,'running provider is not evidence');
    receipt(permit);
    const done=(await service('service-state',{...body,reconcile:true})).json();
    assert.equal(done.job.status,'succeeded');assert.equal(done.canUpdate,true);
    assert.equal(done.receiptRecovery.original.job.status,'unknown');
    assert.equal(done.receiptRecovery.original.job.errorCode,'SBA_TASK_DEADLINE');
    assert.deepEqual(await stub.rawJob(),original);
    assert.equal(state.dispatches,1);assert.equal((await machine()).status,403);
    await f.restart();
    const again=(await service('service-state',{...body,reconcile:true})).json();
    assert.deepEqual(again.receiptRecovery,done.receiptRecovery);assert.equal(again.canUpdate,true);
    assert.equal((await service('plan',{...input,github,repository:'owner/repo',sourceSha:updatedSha,instance:{id:first.taskId,previousTaskId:first.taskId}})).status,200);
    assert.equal(state.dispatches,1);
    assert.doesNotMatch(JSON.stringify(again),new RegExp(permit.permitId));
  } finally {await f.close();}
});

test('late observations reject identity drift, are concurrent-idempotent and fail closed after corruption',async()=>{
  const x=await serviceFixture(),{f,service,input,github,submit,machine,state}=x;
  try {
    const first=(await service('plan',{...input,github,repository:'owner/repo'})).json();
    await submit(first);await machine();
    const owner=(await f.call('/api/admin/state')).json().ownerId;
    const ns=await f.mf.getDurableObjectNamespace('CONNECTED_TASKS'),stub=ns.get(ns.idFromName('connected/v1/'+first.taskId));
    await stub.expireResult();await stub.inspect(owner);
    const raw=JSON.parse(await stub.rawJob()),r=raw.request;
    const envelope={schemaVersion:1,runId:raw.runId,runAttempt:1,executorSha:state.executorSha,requestDigest:raw.requestDigest,permitId:raw.permitId,
      result:{schemaVersion:r.schemaVersion,taskId:r.taskId,action:r.action,sourceSha:r.sourceSha,applicationVersion:r.applicationVersion,status:'succeeded',checks:[{id:'synthetic-check',passed:true}]}};
    await assert.rejects(()=>stub.settle('d'.repeat(64),envelope));
    for(const patch of [{runId:457},{runAttempt:2},{executorSha:'f'.repeat(40)},{requestDigest:'f'.repeat(64)},{permitId:'f'.repeat(64)},{injected:true}])
      await assert.rejects(()=>stub.settle(owner,{...envelope,...patch}));
    assert.equal((await service('service-state',{instanceId:first.taskId,reconcile:false})).json().canUpdate,false);
    await Promise.all([stub.settle(owner,envelope),stub.settle(owner,envelope)]);
    const before=(await service('service-state',{instanceId:first.taskId,reconcile:false})).json();
    await assert.rejects(()=>stub.settle(owner,{...envelope,result:{...envelope.result,status:'failed'}}));
    assert.deepEqual(JSON.parse(await stub.rawJob()),raw);
    await f.restart();
    assert.deepEqual((await service('service-state',{instanceId:first.taskId,reconcile:false})).json().receiptRecovery,before.receiptRecovery);
    const ns2=await f.mf.getDurableObjectNamespace('CONNECTED_TASKS');await ns2.get(ns2.idFromName('connected/v1/'+first.taskId)).corruptLateReceipt();
    await f.restart();assert.equal((await service('service-state',{instanceId:first.taskId,reconcile:false})).status,409);
    assert.equal(state.dispatches,1);
  } finally {await f.close();}
});

test('an existing application UNKNOWN is never replaced by a later successful artifact',async()=>{
  const x=await serviceFixture(),{f,service,input,github,submit,machine,receipt}=x;
  try {
    const first=(await service('plan',{...input,github,repository:'owner/repo'})).json();
    await submit(first);const permit=await(await machine()).json();receipt(permit,'unknown');
    const body={instanceId:first.taskId,reconcile:true},before=(await service('service-state',body)).json();
    receipt(permit,'succeeded');const after=(await service('service-state',body)).json();
    assert.deepEqual(after.job,before.job);assert.equal(after.canUpdate,false);assert.equal(after.receiptRecovery,undefined);
  } finally {await f.close();}
});
