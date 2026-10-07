import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deploymentFixture } from '../cloud/deployment-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';
const {f,input,resource}=await deploymentFixture();let browser;
try{
  let token=f.jwt();browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1280,height:1000}}),errors=[];
  await context.route('**/*',async route=>{const request=route.request();assert.equal(new URL(request.url()).origin,origin);const response=await f.mf.dispatchFetch(request.url(),{method:request.method(),headers:{...request.headers(),'cf-access-jwt-assertion':token},...(request.postData()===null?{}:{body:request.postData()})});await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/deploy');await page.getByText('请选择应用连接与精确版本',{exact:true}).waitFor();
  await page.locator('#deploy-sha').fill(input.sourceSha);await page.locator('#deploy-load').click();await page.getByText('应用声明已读取，请选择目标资源并填写公开配置',{exact:true}).waitFor();
  await page.locator('#deploy-environment').fill('testing');await page.locator('#resource-database').selectOption(resource.id);await page.getByLabel('Worker 名称',{exact:true}).fill('test-worker');await page.locator('#deploy-preview').click();
  await page.getByText('计划已生成，尚未执行部署',{exact:true}).waitFor();assert.match(await page.locator('#deploy-plan').textContent(),/test-database/);assert.equal(await page.locator('#deploy-submit').isDisabled(),true);
  const dir=process.env.DEPLOYMENT_EVIDENCE_DIR??'test-results';await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,'deployment-plan-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(dir,'deployment-plan-mobile.png'),fullPage:true});
  await page.locator('#deploy-cancel').click();assert.equal(await page.locator('#deploy-review').isVisible(),false);
  await page.locator('#deploy-preview').click();await page.getByText('计划已生成，尚未执行部署',{exact:true}).waitFor();await page.getByLabel('Worker 名称',{exact:true}).fill('changed');assert.equal(await page.locator('#deploy-review').isVisible(),false);
  token='invalid';await page.locator('#deploy-preview').click();await page.getByText('身份验证失败，请重新登录',{exact:true}).waitFor();assert.equal(await page.locator('#deploy-inputs').textContent(),'');assert.equal(await page.locator('#deploy-preview').isDisabled(),true);assert.deepEqual(errors,[]);
  console.log('PASS Chrome + workerd declaration-driven plan: exact SHA, generated fields, selected registered resource, review/cancel/edit invalidation, expired identity, mobile; no dispatch');
}finally{await browser?.close();await f.close();}
