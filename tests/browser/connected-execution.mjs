import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connectedFixture } from '../cloud/connected-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';
const {f,input,resource,state,machine,receipt}=await connectedFixture();let browser;
try{
  let token=f.jwt();browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1280,height:1000}}),errors=[];
  await context.route('**/*',async route=>{const request=route.request();assert.equal(new URL(request.url()).origin,origin);const response=await f.mf.dispatchFetch(request.url(),{method:request.method(),headers:{...request.headers(),'cf-access-jwt-assertion':token},...(request.postData()===null?{}:{body:request.postData()})});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/deploy');await page.getByText('连接已读取',{exact:true}).waitFor();
  await page.locator('#deploy-sha').fill(input.sourceSha);await page.locator('#deploy-load').click();await page.getByText('应用声明已读取',{exact:true}).waitFor();
  await page.locator('#deploy-environment').fill('testing');await page.locator('#resource-database').selectOption(resource.id);await page.getByLabel('Worker 名称',{exact:true}).fill('test-worker');await page.locator('#deploy-preview').click();
  await page.getByText('计划已生成，尚未执行部署',{exact:true}).waitFor();assert.match(await page.locator('#deploy-plan').textContent(),/test-database/);assert.equal(await page.locator('#deploy-submit').isDisabled(),false);
  await page.locator('#deploy-cancel').click();assert.equal(state.dispatches,0);
  await page.locator('#deploy-preview').click();await page.getByText('计划已生成，尚未执行部署',{exact:true}).waitFor();
  // The notice can still describe the cancelled preview; wait for the new actionable result.
  await page.waitForFunction(()=>!document.getElementById('deploy-submit').disabled);
  await page.locator('#deploy-submit').evaluate(button=>{button.click();button.click();});
  await page.getByText('任务已记录',{exact:true}).waitFor();assert.equal(state.dispatches,1);
  await page.reload();await page.getByText('连接已读取',{exact:true}).waitFor();await page.locator('#deploy-task-open').click();await page.getByText('已读取任务记录',{exact:true}).waitFor();
  assert.match(await page.locator('#deploy-record').textContent(),/dispatched/);
  assert.equal((await machine('source')).status,200);const permit=await machine();assert.equal(permit.status,200);receipt(await permit.json());
  await page.locator('#deploy-reconcile').click();await page.waitForFunction(()=>document.getElementById('deploy-record').textContent.includes('succeeded'));assert.equal(state.dispatches,1);
  assert.equal(await page.locator('#deploy-run').getAttribute('href'),'https://github.com/owner/executor/actions/runs/456');
  const dir=process.env.DEPLOYMENT_EVIDENCE_DIR??'test-results';await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,'connected-execution-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(dir,'connected-execution-mobile.png'),fullPage:true});
  token='invalid';await page.locator('#deploy-reconcile').click();await page.getByText('身份验证失败，请重新登录',{exact:true}).waitFor();assert.equal(await page.locator('#deploy-inputs').textContent(),'');assert.equal(await page.locator('#deploy-preview').isDisabled(),true);assert.deepEqual(errors,[]);
  console.log('PASS Chrome + workerd connected execution: plan/cancel, one dispatch, reload task index, exact OIDC source/permit and verified receipt, run link, identity cleanup, mobile; synthetic providers');
}finally{await browser?.close();await f.close();}
