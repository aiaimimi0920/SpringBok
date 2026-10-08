import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready, reviewService } from './service-fixture.mjs';
const suite=await serviceBrowser(),{page,state,errors,requests,machine,receipt}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
try{
  const d=structuredClone(state.declaration);d.schemaVersion=2;d.accountMode='single';
  d.accounts=[{key:'runtime',label:'账户',path:['accountId'],secret:'CLOUDFLARE_API_TOKEN'}];
  d.fields=d.fields.map(field=>({...field,template:field.type==='text'?'{instance}-worker':null}));
  d.resources=d.resources.map(row=>({...row,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-db'}));
  d.targets=d.targets.map(target=>({...target,account:'runtime'}));state.declaration=d;state.resources=null;
  state.missingSba.add('owner/second');const provider=state.provider;let creates=0;
  state.provider=async(request,context)=>{
    if(request.url==='https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/d1/database'&&request.method==='POST'){
      creates++;const body=await request.json();return Response.json({success:true,result:{uuid:'87654321-1234-1234-1234-123456789abc',name:body.name}});
    }
    return provider(request,context);
  };
  await ready(page);await page.locator('#service-add').click();await page.locator('[role=tab][data-repository="owner/repo"]').click();
  assert.match(await page.locator('#service-environment').inputValue(),/^app-[a-f0-9]{12}$/);
  assert.equal(await page.locator('#service-inputs input, #service-inputs textarea, #service-resources select').count(),0);
  assert.equal(await page.locator('#service-resource-database').evaluate(el=>el.tagName),'OUTPUT');
  assert.equal(requests.some(row=>['inventory','discover','register'].includes(row.body?.action)),false);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(directory,`automatic-deploy-${width}.png`)});
  }
  await page.locator('#service-environment').fill('my-instance');
  assert.equal(await page.locator('#service-resource-database').textContent(),'my-instance-db');
  await reviewService(page);assert.equal(creates,0);assert.match(await page.locator('#service-review').textContent(),/my-instance-worker/);
  await page.locator('#service-submit').click();await page.waitForFunction(()=>!document.getElementById('service-dialog').open);
  assert.equal(creates,1);assert.equal(state.dispatches,1);assert.equal(state.request.configuration.database.id,'87654321-1234-1234-1234-123456789abc');
  receipt(await(await machine()).json());await ready(page);await page.getByText('部署成功',{exact:true}).waitFor();
  await page.getByRole('button',{name:'切换版本',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#service-version option[value="'+'c'.repeat(40)+'"]'));
  await page.locator('#service-version').selectOption('c'.repeat(40));await reviewService(page);
  await page.locator('#service-submit').click();await page.waitForFunction(()=>!document.getElementById('service-dialog').open);
  assert.equal(creates,1,'updates never provision again');assert.equal(state.dispatches,2);assert.equal(state.request.action,'update');
  assert.equal(state.request.configuration.server.name,'my-instance-worker');assert.deepEqual(errors,[]);
  console.log('Automatic service deploy and retained-resource update passed (synthetic providers).');
}finally{await suite.close();}
