import assert from 'node:assert/strict';
import { serviceBrowser, ready, reviewService } from './service-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';
const suite=await serviceBrowser(),{page,state,errors,input,requests}=suite;
try{
  const d=structuredClone(state.declaration);d.schemaVersion=2;d.accountMode='single';
  d.accounts=[{key:'runtime',label:'账户',path:['accountId'],secret:'CLOUDFLARE_API_TOKEN'}];
  d.fields=d.fields.map(field=>({...field,template:field.type==='text'?'{instance}-worker':null}));
  d.resources=d.resources.map(row=>({...row,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-db'}));
  d.targets=d.targets.map(target=>({...target,account:'runtime'}));
  d.administrator={emailPath:['admin','bootstrapEmail'],secret:'ADMIN_BOOTSTRAP_PASSWORD'};
  state.declaration=d;
  // The fixture normally falls back to its manifest when state.manifest is null.
  state.manifestOverride={secrets:['CLOUDFLARE_API_TOKEN','ADMIN_BOOTSTRAP_PASSWORD']};
  state.resources=null;state.missingSba.add('owner/second');const provider=state.provider;
  state.provider=async(request,context)=>{
    const url=new URL(request.url);
    if(url.pathname.endsWith('/d1/database')&&request.method==='POST'){const body=await request.json();return Response.json({success:true,result:{uuid:'87654321-1234-1234-1234-123456789abc',name:body.name}});}
    return provider(request,context);
  };
  await page.goto(origin+'/resources');await page.waitForFunction(()=>document.getElementById('resource-loading').textContent==='');
  await page.locator('#resource-add').click();await page.getByText('Gmail',{exact:true}).click();
  await page.getByLabel('Gmail 邮箱',{exact:true}).fill('fixture@gmail.com');
  await page.getByLabel('默认管理员密码',{exact:true}).fill('Synthetic-default-Only!42');await page.locator('#resource-save').click();
  await page.waitForFunction(()=>!document.getElementById('resource-dialog').open);
  await page.getByText('fixture@gmail.com',{exact:true}).waitFor();assert.equal(await page.locator('#resource-token').inputValue(),'');
  await ready(page);await page.locator('#service-add').click();await page.locator('[role=tab][data-repository="owner/repo"]').click();await page.locator('#service-cloudflare').selectOption(input.cloudflare.id);
  assert.notEqual(await page.locator('#service-admin-profile').inputValue(),'');
  await page.locator('#service-admin-mode').selectOption('override');await page.locator('#service-admin-password').fill('Synthetic-override-Only!43');
  await reviewService(page);assert.equal(await page.getByText('本次配置',{exact:true}).count(),1);
  const plan=requests.findLast(row=>row.path.endsWith('/plan')).body;assert.ok(plan.administrator.override);assert.ok(!JSON.stringify(plan).includes('Synthetic-'));
  assert.equal(await page.locator('#service-admin-password').inputValue(),'');
  await page.getByRole('button',{name:'返回修改',exact:true}).click();await page.locator('#service-admin-mode').selectOption('default');
  await reviewService(page);assert.equal(await page.getByText('已保存的默认密码',{exact:true}).count(),1);
  assert.equal(requests.findLast(row=>row.path.endsWith('/plan')).body.administrator.override,undefined);
  await page.locator('#service-close').click();assert.equal(state.dispatches,0);assert.deepEqual(errors,[]);
  console.log('Gmail profile UI, encrypted override selection, exact preview and cancellation passed (synthetic providers).');
}finally{await suite.close();}
