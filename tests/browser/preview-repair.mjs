import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
import { configurePreviewFixture } from '../cloud/preview-fixture.mjs';
import { updatedSha } from '../cloud/service-fixture.mjs';

const suite=configurePreviewFixture(await serviceBrowser({ENABLE_SERVICE_REPAIR:'yes'}));
const {page,state,service,submit,machine,receipt,api,complete,errors}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
try{
  const first=(await service('plan',suite.input)).json();assert.equal((await submit(first)).status,200);
  complete(await(await machine()).json());await service('service-state',{instanceId:first.taskId,reconcile:true});
  const preview=(await service('plan',{action:'rehearse',instanceId:first.taskId,previousTaskId:first.taskId,
    sourceSha:updatedSha,environment:'test-123456789abc'})).json();assert.equal((await submit(preview)).status,200);
  receipt(await(await machine()).json(),'unknown',{checks:[],errorCode:'COPY_CREDENTIAL_FAILED'});
  const failed=(await service('service-state',{instanceId:preview.taskId,reconcile:true})).json();
  state.tagPages=[];state.updateVersion='3.0.0';
  state.manifestOverride={...state.manifestOverride,actions:{...state.manifestOverride.actions,repair:{timeoutSeconds:300}},
    repairs:[{id:'complete-copy',name:'完成测试副本',fromErrorCodes:['COPY_CREDENTIAL_FAILED'],secretNames:['CLOUDFLARE_API_TOKEN']}]};
  await ready(page);const row=page.locator('li').filter({has:page.getByRole('button',{name:'修复',exact:true})});
  await row.getByRole('button',{name:'修复',exact:true}).click();
  await page.getByRole('button',{name:'指定来源',exact:true}).click();
  await page.getByLabel('提交 SHA',{exact:true}).fill('5'.repeat(40));
  await page.getByRole('button',{name:'读取版本',exact:true}).click();
  await page.locator('#service-dialog-notice').filter({hasText:'此版本没有匹配当前错误的修复操作'}).waitFor();
  assert.equal(await page.locator('#service-submit').isDisabled(),true);assert.equal(state.dispatches,2);
  state.manifestOverride.repairs[0].fromActions=['preview'];
  await page.getByRole('button',{name:'读取版本',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('service-submit').disabled);
  assert.equal(await page.locator('#service-repair').inputValue(),'complete-copy');
  await page.locator('#service-submit').click();await page.locator('#service-review').waitFor({state:'visible'});
  assert.match(await page.locator('#service-review').textContent(),new RegExp(preview.taskId));
  assert.match(await page.locator('#service-review').textContent(),/COPY_CREDENTIAL_FAILED/);
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(directory,`preview-repair-${width}.png`)});}
  await page.locator('#service-submit').evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>!document.getElementById('service-dialog').open);assert.equal(state.dispatches,3);
  const permit=await(await machine()).json(),context=permit.request.context.preview;
  assert.deepEqual(context,failed.job.request.context);assert.deepEqual(permit.request.configuration,failed.configuration);
  assert.equal(state.created.length,2);assert.equal((await machine()).status,403);
  receipt(permit,'succeeded',{checks:['snapshot-copied','migration-verified','source-unchanged','side-effects-isolated',
    'repair-completed','data-preserved','unchanged-resources-verified','service-ready'].map(id=>({id,passed:true})),lifecycle:{
    resources:context.resources.map(item=>({key:item.key,status:'created'})),urls:context.urls,snapshot:{id:'e'.repeat(64),createdAt:7}}});
  await ready(page);await page.getByRole('button',{name:'删除测试环境',exact:true}).click();
  await page.locator('#service-review').filter({hasText:'将永久删除以上测试资源及其中的数据'}).waitFor({state:'visible'});
  assert.equal(state.dispatches,3,'cleanup review must not execute deletion');
  await page.keyboard.press('Escape');assert.equal(state.dispatches,3);
  assert.deepEqual((await api('state',{taskId:preview.taskId})).json().job,failed.job);
  assert.equal((await service('service-state',{instanceId:first.taskId,reconcile:false})).json().history.length,1);
  assert.deepEqual(errors,[]);
  console.log('Failed preview uses explicit repair scope, original resources, one dispatch and authenticated cleanup review; source and UNKNOWN history preserved.');
}finally{await suite.close();}
