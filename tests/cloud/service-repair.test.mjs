import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, updatedSha } from './service-fixture.mjs';
import { previewManifest } from '../sba-preview-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
import { randomUUID } from 'node:crypto';

async function setup(enabled='yes',bootstrap=false) {
  const f=await serviceFixture({ENABLE_SERVICE_REPAIR:enabled});
  f.state.manifestOverride={schemaVersion:3,actions:previewManifest().actions};
  if(bootstrap){
    const d=structuredClone(f.state.declaration);
    f.state.declaration={...d,schemaVersion:2,accountMode:'single',accounts:[{key:'runtime',label:'账户',path:['accountId'],secret:'CLOUDFLARE_API_TOKEN'}],
      fields:d.fields.map(row=>({...row,template:row.type==='text'?'{instance}-worker':null})),
      resources:d.resources.map(row=>({...row,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-db'})),
      targets:d.targets.map(row=>({...row,account:'runtime'})),administrator:{emailPath:['admin','bootstrapEmail'],secret:'ADMIN_BOOTSTRAP_PASSWORD'}};
    f.state.manifestOverride.secrets=['CLOUDFLARE_API_TOKEN','ADMIN_BOOTSTRAP_PASSWORD'];
    const provider=f.state.provider;f.state.creates=[];f.state.resources=null;
    f.state.provider=async(request,context)=>{
      if(request.method==='POST'&&request.url.endsWith('/d1/database')){const body=await request.json();f.state.creates.push(body);return Response.json({success:true,result:{uuid:'87654321-1234-1234-1234-123456789abc',name:body.name}});}
      if(request.url.endsWith('/workers/subdomain'))return Response.json({success:true,result:{subdomain:'synthetic-test'}});
      return provider(request,context);
    };
    const id=randomUUID();assert.equal((await f.f.call('/api/admin/resources',{...f.session,body:{action:'admin-profile',id,email:'fixture@gmail.com',password:'Synthetic-Only-Password!42'}})).status,200);
    f.input.values={};f.input.resources={};f.input.administrator={profile:{id,revision:1}};
  }
  const first=(await f.service('plan',{...f.input,github:f.github,repository:'owner/repo'})).json();
  assert.equal((await f.submit(first)).status,200);
  f.receipt(await(await f.machine()).json(),'unknown',{errorCode:'ADMIN_PUBLISH_FAILED'});
  const original=(await f.api('reconcile',{taskId:first.taskId})).json();assert.equal(original.job.status,'unknown');
  f.state.manifestOverride={schemaVersion:3,actions:{...previewManifest().actions,repair:{timeoutSeconds:300}},
    secrets:['CLOUDFLARE_API_TOKEN',...(bootstrap?['ADMIN_BOOTSTRAP_PASSWORD']:[])],repairs:[{id:'admin-publish',name:'补发后台',fromErrorCodes:['ADMIN_PUBLISH_FAILED'],secretNames:['CLOUDFLARE_API_TOKEN']}]};
  return {...f,first,original,body:{action:'repair',instanceId:first.taskId,previousTaskId:first.taskId,sourceSha:updatedSha,repairId:'admin-publish'}};
}

test('repair preserves parent receipt, atomically continues held lane, uses one permit and survives restart',async()=>{
  const {f,state,service,submit,machine,receipt,api,first,original,body}=await setup();
  try{
    assert.equal((await service('service-state',{instanceId:first.taskId,reconcile:false})).json().canRepair,true);
    const preview=await service('plan',body);assert.equal(preview.status,200,preview.text);const plan=preview.json();
    assert.equal(plan.plan.operation.context.resultDigest.length,64);assert.equal(plan.plan.credentials.CLOUDFLARE_API_TOKEN,'cloudflare');
    const replies=await Promise.all([submit(plan),submit(plan)]);assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies));
    assert.equal(state.dispatches,2);assert.equal(state.request.action,'repair');assert.deepEqual(state.request.configuration,original.job.request.configuration);
    assert.equal((await service('plan',body)).status,409,'stale parent cannot start another repair');
    const permit=await(await machine()).json();assert.equal(permit.secrets.CLOUDFLARE_API_TOKEN,fakeToken);assert.equal(Object.hasOwn(permit.secrets,'ADMIN_BOOTSTRAP_PASSWORD'),false);
    assert.equal((await machine()).status,403);
    await f.restart();
    receipt(permit,'succeeded',{checks:['repair-completed','data-preserved','unchanged-resources-verified','service-ready'].map(id=>({id,passed:true}))});
    const done=(await service('service-state',{instanceId:first.taskId,reconcile:true})).json();
    assert.equal(done.job.status,'succeeded');assert.equal(done.history.length,2);assert.equal(done.instance.id,first.taskId);assert.equal(done.canUpdate,true);assert.equal(done.canRepair,false);
    assert.deepEqual((await api('state',{taskId:first.taskId})).json().job,original.job);
    assert.equal(state.dispatches,2);
  }finally{await f.close();}
});

test('repair refuses disabled feature, missing source evidence, undeclared scope and changed resource declaration',async()=>{
  const disabled=await setup('no');try{assert.equal((await disabled.service('service-state',{instanceId:disabled.first.taskId,reconcile:false})).json().canRepair,false);assert.equal((await disabled.service('plan',disabled.body)).status,409);assert.equal(disabled.state.dispatches,1);}finally{await disabled.f.close();}
  const {f,state,service,body}=await setup();
  try{
    assert.equal((await service('plan',{...body,repairId:'other'})).status,409);
    assert.equal((await service('plan',{...body,previousTaskId:'dc-'+'f'.repeat(32)})).status,409);
    state.badTitle=true;assert.equal((await service('plan',body)).status,409);state.badTitle=false;
    state.runStatus='in_progress';assert.equal((await service('plan',body)).status,409);state.runStatus='completed';
    state.updateDeclaration={targets:[]};assert.equal((await service('plan',body)).status,409);
    assert.equal(state.dispatches,1);
  }finally{await f.close();}
});

test('lost repair dispatch remains unknown and is not silently replayed',async()=>{
  const {f,state,service,submit,body,api,first,original}=await setup();
  try{
    const response=await service('plan',body);assert.equal(response.status,200,response.text);const plan=response.json();
    state.dispatchLost=true;assert.equal((await submit(plan)).status,200);assert.equal(state.dispatches,2);
    await f.restart();assert.equal((await submit(plan)).status,200);assert.equal(state.dispatches,2);
    assert.equal((await service('plan',body)).status,409);
    assert.deepEqual((await api('state',{taskId:first.taskId})).json().job,original.job);
  }finally{await f.close();}
});

test('repair reuses automatic resource IDs and never releases the saved administrator password',async()=>{
  const {f,state,service,submit,machine,body,original}=await setup('yes',true);
  try{
    const preview=await service('plan',body);assert.equal(preview.status,200,preview.text);const plan=preview.json();
    assert.equal(plan.plan.credentials.ADMIN_BOOTSTRAP_PASSWORD,'repair-disabled');
    assert.equal((await submit(plan)).status,200);assert.equal(state.creates.length,1,'only the original deployment creates a database');
    const permit=await(await machine()).json();assert.equal(permit.secrets.ADMIN_BOOTSTRAP_PASSWORD,'repair-not-applicable');
    assert.ok(!JSON.stringify(permit).includes('Synthetic-Only-Password!42'));
    assert.deepEqual(permit.request.configuration,original.job.request.configuration);
  }finally{await f.close();}
});

test('manual resource repair persists disabled secret mapping before permit',async()=>{
  const {f,state,service,submit,machine,body}=await setup();
  try{
    state.manifestOverride.repairs[0].secretNames=[];
    const response=await service('plan',body);assert.equal(response.status,200,response.text);
    assert.equal((await submit(response.json())).status,200);
    const permit=await(await machine()).json();assert.equal(permit.secrets.CLOUDFLARE_API_TOKEN,'repair-not-applicable');
    assert.ok(!JSON.stringify(permit).includes(fakeToken));
  }finally{await f.close();}
});

test('different approved repair tasks cannot concurrently take the same failed parent',async()=>{
  const {f,state,service,submit,body}=await setup();
  try{
    const first=(await service('plan',body)).json(),second=(await service('plan',body)).json();
    assert.notEqual(first.taskId,second.taskId);
    const responses=await Promise.all([submit(first),submit(second)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(state.dispatches,2);
  }finally{await f.close();}
});

for(const repairStatus of ['succeeded','unknown'])test(`independent verify of ${repairStatus} repair is exact, secret-free, immutable and one-shot`,async()=>{
  const {f,state,service,submit,machine,receipt,api,session,first,original,body}=await setup('yes',true);
  try{
    const plan=(await service('plan',body)).json();assert.equal((await submit(plan)).status,200);
    const repairedRequest=structuredClone(state.request),verifyBody={instanceId:first.taskId,previousTaskId:plan.taskId};
    assert.equal((await api('verify',verifyBody)).status,409,'in-progress repair is not verifiable');
    receipt(await(await machine()).json(),repairStatus,repairStatus==='succeeded'?
      {checks:['repair-completed','data-preserved','unchanged-resources-verified','service-ready'].map(id=>({id,passed:true}))}:{errorCode:'REPAIR_PROVIDER_UNKNOWN'});
    const repaired=(await service('service-state',{instanceId:first.taskId,reconcile:true})).json();
    assert.equal(repaired.job.status,repairStatus);assert.equal(repaired.canVerify,true);
    assert.equal((await api('verify',{...verifyBody,previousTaskId:first.taskId})).status,409);
    assert.equal((await f.call('/api/admin/deployments/verify',{token:session.token,body:verifyBody})).status,403);
    assert.equal((await f.call('/api/admin/deployments/verify',{...session,token:f.jwt({sub:'foreign'}),body:verifyBody})).status,403);
    const replies=await Promise.all([api('verify',verifyBody),api('verify',verifyBody)]);
    assert.ok(replies.every(row=>row.status===200),JSON.stringify(replies));assert.equal(state.dispatches,3);
    assert.equal(state.request.action,'verify');assert.notEqual(state.request.taskId,plan.taskId);
    assert.equal(state.request.sourceSha,repairedRequest.sourceSha);assert.equal(state.request.applicationVersion,repairedRequest.applicationVersion);
    assert.deepEqual(state.request.configuration,repairedRequest.configuration);assert.equal(Object.hasOwn(state.request,'context'),false);
    assert.deepEqual(state.request.previous,{sourceSha:repairedRequest.sourceSha,applicationVersion:repairedRequest.applicationVersion});
    await f.restart();
    const permit=await(await machine()).json();assert.deepEqual(permit.secrets,{CLOUDFLARE_API_TOKEN:'verification-not-applicable',ADMIN_BOOTSTRAP_PASSWORD:'verification-not-applicable'});
    assert.ok(!JSON.stringify(permit).includes(fakeToken));assert.equal((await machine()).status,403);
    receipt(permit);
    const verified=(await service('service-state',{instanceId:first.taskId,reconcile:true})).json();
    assert.equal(verified.verification.status,'succeeded');assert.deepEqual(verified.job,repaired.job);
    assert.deepEqual((await api('state',{taskId:first.taskId})).json().job,original.job);
    assert.equal(verified.canUpdate,repairStatus==='succeeded');assert.equal(verified.canVerify,false);
    if(repairStatus==='unknown')assert.equal(verified.canDelete,false,'verification does not free UNKNOWN claims');
    await f.restart();assert.equal((await api('verify',verifyBody)).status,200);assert.equal(state.dispatches,3);
    assert.equal((await api('verify',{instanceId:first.taskId,previousTaskId:permit.request.taskId})).status,409);
  }finally{await f.close();}
});

test('lost verification dispatch after repair keeps the reservation across restart and is not replayed',async()=>{
  const {f,state,service,submit,machine,receipt,api,first,body}=await setup();
  try{
    const plan=(await service('plan',body)).json();assert.equal((await submit(plan)).status,200);
    receipt(await(await machine()).json(),'unknown',{errorCode:'REPAIR_PROVIDER_UNKNOWN'});
    const repaired=(await service('service-state',{instanceId:first.taskId,reconcile:true})).json();
    const verifyBody={instanceId:first.taskId,previousTaskId:plan.taskId};state.dispatchLost=true;
    const lost=await api('verify',verifyBody);assert.equal(lost.status,200);assert.equal(lost.json().status,'dispatch-unknown');assert.equal(state.dispatches,3);
    await f.restart();state.dispatchLost=false;
    assert.equal((await api('verify',verifyBody)).status,200);assert.equal(state.dispatches,3);
    const restored=(await service('service-state',{instanceId:first.taskId,reconcile:false})).json();
    assert.equal(restored.verification.status,'dispatch-unknown');assert.deepEqual(restored.job,repaired.job);
    assert.equal(restored.canUpdate,false);assert.equal(restored.canDelete,false);
  }finally{await f.close();}
});
