import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
import { previewManifest } from '../sba-preview-fixture.mjs';
import { updatedSha } from '../cloud/service-fixture.mjs';
const suite=await serviceBrowser({ENABLE_SERVICE_REPAIR:'yes'}),{page,state,service,submit,machine,receipt,api,errors,requests,input,github}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
try{
  state.manifestOverride={schemaVersion:3,actions:previewManifest().actions};
  const original=(await service('plan',{...input,github,repository:'owner/repo'})).json();assert.equal((await submit(original)).status,200);
  receipt(await(await machine()).json(),'unknown',{errorCode:'ADMIN_PUBLISH_FAILED'});
  const parent=(await api('reconcile',{taskId:original.taskId})).json();
  await ready(page);await page.getByRole('button',{name:'修复',exact:true}).click();
  await page.locator('#service-repair').waitFor();assert.equal(await page.locator('#service-submit').isDisabled(),true);
  state.manifestOverride={schemaVersion:3,actions:{...previewManifest().actions,repair:{timeoutSeconds:300}},repairs:[{id:'admin-publish',name:'补发后台',fromErrorCodes:['ADMIN_PUBLISH_FAILED'],secretNames:['CLOUDFLARE_API_TOKEN']}]};
  await page.locator('#service-version').selectOption(updatedSha);
  await page.waitForFunction(()=>!document.getElementById('service-submit').disabled);
  assert.equal(await page.locator('#service-repair').inputValue(),'admin-publish');
  await page.locator('#service-submit').click();await page.locator('#service-review').waitFor({state:'visible'});
  assert.match(await page.locator('#service-review').textContent(),/ADMIN_PUBLISH_FAILED/);
  assert.match(await page.locator('#service-review').textContent(),new RegExp(original.taskId));assert.equal(state.dispatches,1);
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,`service-repair-${width}.png`)});}
  await page.locator('#service-back').click();assert.equal(await page.locator('#service-review').isVisible(),false);
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'修复',exact:true}).evaluate(el=>el===document.activeElement),true);assert.equal(state.dispatches,1);
  await page.getByRole('button',{name:'修复',exact:true}).click();await page.locator('#service-version').selectOption(updatedSha);
  await page.waitForFunction(()=>!document.getElementById('service-submit').disabled);
  await page.locator('#service-submit').click();await page.locator('#service-review').waitFor({state:'visible'});
  await page.locator('#service-submit').evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>!document.getElementById('service-dialog').open);
  assert.equal(state.dispatches,2);assert.equal(state.request.action,'repair');assert.deepEqual(state.request.configuration,parent.job.request.configuration);
  const permit=await(await machine()).json();receipt(permit,'succeeded',{checks:['repair-completed','data-preserved','unchanged-resources-verified','service-ready'].map(id=>({id,passed:true}))});
  await ready(page);assert.equal(await page.getByRole('button',{name:'修复',exact:true}).count(),0);
  assert.deepEqual((await api('state',{taskId:original.taskId})).json().job,parent.job);
  const repairPlans=requests.filter(r=>r.path.endsWith('/plan')&&r.body?.action==='repair');assert.equal(repairPlans.length,2);
  assert.deepEqual(errors,[]);console.log('Repair fixed-version selection, preview/back/cancel, one dispatch, unchanged parent and responsive UI passed.');
}finally{await suite.close();}
