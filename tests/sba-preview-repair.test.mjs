import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';
import { previewManifest, previewRequest, previewResult } from './sba-preview-fixture.mjs';
import { repairPreviewContext, repairPreviewBaseline } from '../src/sba/repair.mjs';

const manifest = () => ({ ...previewManifest(), version:'3.0.0', actions:{...previewManifest().actions,repair:{timeoutSeconds:300}},
  repairs:[{id:'complete-copy',name:'完成测试副本',fromErrorCodes:['COPY_CREDENTIAL_FAILED'],fromActions:['preview'],secretNames:[]}] });
const request = () => {
  const parent=previewRequest();
  return {...parent,taskId:'dc-'+'3'.repeat(32),action:'repair',sourceSha:'c'.repeat(40),applicationVersion:'3.0.0',
    previous:{sourceSha:parent.sourceSha,applicationVersion:parent.applicationVersion},context:{repairId:'complete-copy',
      parentTaskId:parent.taskId,parentRunId:42,requestDigest:'c'.repeat(64),resultDigest:'d'.repeat(64),
      errorCode:'COPY_CREDENTIAL_FAILED',preview:parent.context}};
};
const result = () => {
  const selected=request(), value=previewResult({...selected,context:selected.context.preview});
  value.checks.push(...['repair-completed','data-preserved','unchanged-resources-verified','service-ready'].map(id=>({id,passed:true})));
  return value;
};

test('preview repair explicitly selects the parent action and carries the original bounded preview context',()=>{
  assert.deepEqual(validateManifest(manifest()),manifest());
  assert.deepEqual(validateRequest(request(),manifest()),request());
  assert.deepEqual(validateResult(result(),request()),result());
});
test('default repair never opts into preview, while preview-only repair cannot omit its source context',()=>{
  const plain=manifest();delete plain.repairs[0].fromActions;
  assert.throws(()=>validateRequest(request(),plain));
  const missing=request();delete missing.context.preview;assert.throws(()=>validateRequest(missing,manifest()));
  for(const actions of [[],['preview','preview'],['destroy-preview'],['verify'],['arbitrary']]){
    const value=manifest();value.repairs[0].fromActions=actions;assert.throws(()=>validateManifest(value));
  }
});
test('preview repair rejects retargeting, shared identities, wrong evidence and incomplete lifecycle success',()=>{
  for(const mutate of [r=>r.context.preview.resources.push(r.context.preview.source.resources[0]),
    r=>r.context.preview.urls.push('https://foreign.example.invalid'),r=>r.context.preview.source.sourceSha=r.sourceSha,
    r=>r.context.preview.source.resultDigest='bad',r=>r.context.parentTaskId=r.taskId,
    r=>r.context.preview.extra=true]){
    const value=request();mutate(value);assert.throws(()=>validateRequest(value,manifest()));
  }
  for(const mutate of [r=>delete r.lifecycle,r=>r.lifecycle.resources[0].status='unknown',r=>r.lifecycle.snapshot=null,
    r=>{r.checks=r.checks.filter(row=>row.id!=='source-unchanged');},r=>{r.checks=r.checks.filter(row=>row.id!=='repair-completed');}]){
    const value=result();mutate(value);assert.throws(()=>validateResult(value,request()));
  }
  const unknown={...result(),status:'unknown',checks:[],errorCode:'COPY_CREDENTIAL_FAILED'};delete unknown.lifecycle;
  assert.deepEqual(validateResult(unknown,request()),unknown);
});

test('optional preview baseline is exact, bounded and cannot name the current candidate or source',()=>{
  const value=request();value.context.previewBaseline={...value.previous,instanceId:value.context.parentTaskId};
  assert.deepEqual(validateRequest(value,manifest()),value);
  for(const baseline of [{...value.context.previewBaseline,sourceSha:'bad'},
    {...value.context.previewBaseline,extra:true},{...value.context.previewBaseline,sourceSha:value.sourceSha},
    {...value.context.previewBaseline,sourceSha:value.context.preview.source.sourceSha},
    {...value.context.previewBaseline,instanceId:value.context.preview.source.instanceId},
    {...value.context.previewBaseline,applicationVersion:'9.0.0'}]){
    const invalid=structuredClone(value);invalid.context.previewBaseline=baseline;
    assert.throws(()=>validateRequest(invalid,manifest()));
  }
  const plain=request();delete plain.context.preview;plain.context.previewBaseline={...plain.previous,instanceId:plain.context.parentTaskId};
  const m=manifest();m.repairs[0].fromActions=['repair'];assert.throws(()=>validateRequest(plain,m));
});

test('legacy first repair without a baseline derives it from the authenticated previous release',()=>{
  const parent=request();assert.deepEqual(repairPreviewBaseline(parent),{...parent.previous,instanceId:parent.context.parentTaskId});
  assert.deepEqual(repairPreviewContext(parent),parent.context.preview);
  parent.context.previewBaseline={sourceSha:'e'.repeat(40),applicationVersion:'2.0.0',instanceId:parent.context.parentTaskId};
  assert.deepEqual(repairPreviewBaseline(parent),parent.context.previewBaseline);
  assert.equal(repairPreviewContext({action:'repair',context:{}}),null);
});
