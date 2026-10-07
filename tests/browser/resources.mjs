import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectionsFixture, fakeToken } from '../cloud/connections-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';
const {f,state}=await connectionsFixture();let browser;
try{
  let token=f.jwt();const auth=(await f.call('/api/admin/state',{token})).json();
  assert.equal((await f.call('/api/admin/connections',{token,headers:{'x-csrf-token':auth.csrf},body:{action:'create',id:randomUUID(),name:'Cloudflare 测试账号',provider:'cloudflare',target:'a'.repeat(32),token:fakeToken}})).status,200);
  state.resources={success:true,result:[{uuid:'12345678-1234-1234-1234-123456789abc',name:'已有数据库'}]};
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1280,height:950}}),errors=[],writes=[];
  let holdDiscovery,releaseDiscovery;
  await context.route('**/*',async route=>{
    const request=route.request();assert.equal(new URL(request.url()).origin,origin);
    if(request.method()==='POST') { const body=request.postDataJSON();writes.push(body);if(body.action==='discover' && holdDiscovery)await holdDiscovery; }
    const response=await f.mf.dispatchFetch(request.url(),{method:request.method(),headers:{...request.headers(),'cf-access-jwt-assertion':token},...(request.postData()===null?{}:{body:request.postData()})});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/settings');await page.getByRole('link',{name:'云资源',exact:true}).click();
  await page.locator('#resource-notice').getByText('请选择资源类型并读取',{exact:true}).waitFor();
  const directory=process.env.CONNECTIONS_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
  await page.getByRole('button',{name:'添加资源',exact:true}).click();
  assert.equal(await page.getByRole('radio',{name:'D1 数据库'}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#resource-kind').inputValue(),'kv');
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#resource-kind').inputValue(),'d1');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#resource-dialog').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#resource-add').evaluate(el=>el===document.activeElement),true);
  await page.locator('#resource-add').click();await page.locator('#resource-close').click();await page.locator('#resource-add').click();
  assert.equal(writes.length,0,'Opening, closing and changing resource type must not write');
  await page.screenshot({path:join(directory,'resources-dialog-desktop.png'),fullPage:true});
  holdDiscovery=new Promise(resolve=>{releaseDiscovery=resolve;});
  await page.getByRole('button',{name:'读取已有资源',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('resource-fields').disabled);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#resource-add').evaluate(el=>el===document.activeElement),true);
  await page.locator('#resource-add').click();assert.equal(await page.locator('#resource-close').evaluate(el=>el===document.activeElement),true);
  releaseDiscovery();holdDiscovery=null;
  await page.getByRole('button',{name:'登记资源',exact:true}).click();assert.equal(writes.filter(body=>body.action==='discover').length,1);
  await page.locator('#resource-dialog-notice').getByText('资源已登记，没有创建或修改云资源',{exact:true}).waitFor();assert.equal(await page.locator('#resource-registered li').count(),1);
  await page.reload();await page.locator('#resource-notice').getByText('请选择资源类型并读取',{exact:true}).waitFor();assert.equal(await page.locator('#resource-registered li').count(),1);
  await page.screenshot({path:join(directory,'resources-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#resource-add').click();await page.getByText('R2 对象存储',{exact:true}).click();state.resources={success:true,result:{buckets:[{name:'test-bucket'}]}};
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.locator('#resource-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);}
  await page.screenshot({path:join(directory,'resources-dialog-mobile.png'),fullPage:true});
  await page.locator('#resource-form').evaluate(form=>form.requestSubmit());await page.getByRole('button',{name:'登记资源',exact:true}).waitFor();
  token='invalid';await page.getByRole('button',{name:'登记资源',exact:true}).click();await page.locator('#resource-dialog-notice').getByText('身份验证失败，请重新登录',{exact:true}).waitFor();
  assert.equal(await page.locator('#resource-registered li').count(),0);assert.equal(await page.locator('#resource-discovered li').count(),0);assert.equal(await page.locator('#resource-fields').evaluate(fieldset=>fieldset.disabled),true);
  await page.locator('#resource-close').click();assert.equal(await page.locator('#resource-add').evaluate(el=>el===document.activeElement),true);
  token=f.jwt();await page.locator('#resource-refresh').click();await page.locator('#resource-notice').getByText('请选择资源类型并读取',{exact:true}).waitFor();
  await page.locator('#resource-add').click();token='invalid';await page.locator('#resource-form').evaluate(form=>form.requestSubmit());await page.locator('#resource-dialog-notice').getByText('身份验证失败，请重新登录',{exact:true}).waitFor();
  assert.equal(await page.locator('#resource-registered li').count(),0);assert.equal(await page.locator('#resource-fields').evaluate(fieldset=>fieldset.disabled),true);
  await page.screenshot({path:join(directory,'resources-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
  console.log('PASS Chrome + workerd resources: observed D1 registration, reload, R2 discovery, identity expiry on discover/register, mobile; synthetic providers only');
}finally{await browser?.close();await f.close();}
