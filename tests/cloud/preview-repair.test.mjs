import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFixture } from './preview-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';

async function setup(){
  const f=await previewFixture({ENABLE_SERVICE_REPAIR:'yes'});
  const first=(await f.service('plan',f.input)).json();assert.equal((await f.submit(first)).status,200);
  f.complete(await(await f.machine()).json());await f.service('service-state',{instanceId:first.taskId,reconcile:true});
  const planned=(await f.service('plan',{action:'rehearse',instanceId:first.taskId,previousTaskId:first.taskId,
    sourceSha:updatedSha,environment:'test-123456789abc'})).json();assert.equal((await f.submit(planned)).status,200);
  const permit=await(await f.machine()).json();f.receipt(permit,'unknown',{checks:[],errorCode:'COPY_CREDENTIAL_FAILED'});
  const failed=(await f.service('service-state',{instanceId:planned.taskId,reconcile:true})).json();
  f.state.updateVersion='3.0.0';f.state.manifestOverride={...f.state.manifestOverride,
    actions:{...f.state.manifestOverride.actions,repair:{timeoutSeconds:300}},
    repairs:[{id:'complete-copy',name:'完成测试副本',fromErrorCodes:['COPY_CREDENTIAL_FAILED'],fromActions:['preview'],secretNames:['CLOUDFLARE_API_TOKEN']}]};
  return {...f,first,planned,failed,body:{action:'repair',instanceId:planned.taskId,previousTaskId:planned.taskId,
    sourceSha:'5'.repeat(40),repairId:'complete-copy'}};
}

test('preview repair reuses the failed target, keeps the source and UNKNOWN history, then supports authenticated cleanup',async()=>{
  const f=await setup();
  try{
    assert.equal(f.failed.job.status,'unknown');assert.equal(f.failed.canDeletePreview,false);assert.equal(f.failed.canRepair,true);
    const reply=await f.service('plan',f.body);assert.equal(reply.status,200,reply.text);const plan=reply.json();
    assert.deepEqual(plan.plan.operation.context.preview,f.failed.job.request.context);
    assert.equal(plan.plan.previewOf.instanceId,f.first.taskId);
    const replies=await Promise.all([f.submit(plan),f.submit(plan)]);assert.ok(replies.every(row=>row.status===200));
    assert.equal(f.state.dispatches,3);assert.equal(f.state.created.length,2,'repair cannot create another resource');
    const permit=await(await f.machine()).json();assert.deepEqual(permit.request.configuration,f.failed.configuration);
    assert.deepEqual(permit.request.context.preview,f.failed.job.request.context);assert.equal((await f.machine()).status,403);
    assert.equal((await f.service('plan',f.body)).status,409);
    await f.f.restart();const context=permit.request.context.preview;
    f.receipt(permit,'succeeded',{checks:['snapshot-copied','migration-verified','source-unchanged','side-effects-isolated',
      'repair-completed','data-preserved','unchanged-resources-verified','service-ready'].map(id=>({id,passed:true})),
      lifecycle:{resources:context.resources.map(row=>({key:row.key,status:'created'})),urls:context.urls,snapshot:{id:'e'.repeat(64),createdAt:7}}});
    const done=(await f.service('service-state',{instanceId:f.planned.taskId,reconcile:true})).json();
    assert.equal(done.job.status,'succeeded');assert.equal(done.instance.id,f.planned.taskId);assert.equal(done.history.length,2);
    assert.equal(done.canDeletePreview,true);assert.equal(done.canUpdate,false);assert.equal(done.canPreview,false);
    assert.deepEqual(done.testUrls,context.urls);
    assert.deepEqual((await f.api('state',{taskId:f.planned.taskId})).json().job,f.failed.job);
    const remove=await f.service('plan',{action:'destroy-preview',instanceId:f.planned.taskId,previousTaskId:plan.taskId});
    assert.equal(remove.status,200,remove.text);const cleanup=remove.json();
    assert.equal(cleanup.plan.operation.context.instanceId,f.planned.taskId);assert.equal(cleanup.plan.operation.context.previewTaskId,plan.taskId);
    assert.equal(Object.hasOwn(cleanup.plan.operation.context,'source'),false);
    assert.deepEqual(cleanup.plan.operation.context.resources,context.resources);
    const original=(await f.service('service-state',{instanceId:f.first.taskId,reconcile:false})).json();
    assert.equal(original.job.status,'succeeded');assert.equal(original.history.length,1);
  }finally{await f.f.close();}
});
test('preview repair refuses implicit scopes, owner/CSRF changes, stale heads and invented parent context before dispatch',async()=>{
  const f=await setup();
  try{
    delete f.state.manifestOverride.repairs[0].fromActions;assert.equal((await f.service('plan',f.body)).status,409);
    f.state.manifestOverride.repairs[0].fromActions=['deploy'];assert.equal((await f.service('plan',f.body)).status,409);
    f.state.manifestOverride.repairs[0].fromActions=['preview'];
    assert.equal((await f.service('plan',{...f.body,context:f.failed.job.request.context})).status,409);
    assert.equal((await f.service('plan',{...f.body,previousTaskId:f.first.taskId})).status,409);
    assert.equal((await f.f.call('/api/admin/deployments/plan',{token:f.session.token,body:f.body})).status,403);
    assert.equal((await f.f.call('/api/admin/deployments/plan',{...f.session,token:f.f.jwt({sub:'foreign'}),body:f.body})).status,403);
    f.state.runStatus='in_progress';assert.equal((await f.service('plan',f.body)).status,409);
    assert.equal(f.state.dispatches,2);assert.equal(f.state.created.length,2);
  }finally{await f.f.close();}
});
