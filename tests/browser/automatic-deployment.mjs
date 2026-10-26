import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready, reviewService } from './service-fixture.mjs';
const suite=await serviceBrowser(),{page,state,errors,requests,machine,receipt}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
const business=process.env.APPLICATION_SECRETS==='1',privateValues={APP_COOKIE_SECRET:'Synthetic-Cookie-Only!42',APP_STORAGE_KEY:'synthetic-storage-only'};
try{
  const d=structuredClone(state.declaration);d.schemaVersion=2;d.accountMode='single';
  d.accounts=[{key:'runtime',label:'账户',path:['accountId'],secret:'CLOUDFLARE_API_TOKEN'}];
  d.fields=d.fields.map(field=>({...field,template:field.type==='text'?'{instance}-worker':null}));
  d.resources=d.resources.map(row=>({...row,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-db'}));
  d.targets=d.targets.map(target=>({...target,account:'runtime'}));state.declaration=d;state.resources=null;
  if(process.env.SUITE_TARGETS==='1'){
    d.target='cloudflare-suite';d.github={repositoryPath:['automation','repository'],secret:'DEPLOY_GITHUB_TOKEN'};
    d.fields.push({path:['pages'],label:'Pages',type:'text',required:true,template:'{instance}-pages'},
      {path:['workflow'],label:'Actions',type:'text',required:true,template:'.github/workflows/refresh.yml@{instance}'});
    d.targets.push({kind:'pages',path:['pages'],account:'runtime'},{kind:'github-actions',path:['workflow'],account:null});
    state.manifestOverride={secrets:['CLOUDFLARE_API_TOKEN','DEPLOY_GITHUB_TOKEN']};
  }
  if(business){d.applicationSecrets=Object.keys(privateValues);state.manifestOverride.secrets.push(...d.applicationSecrets);}
  state.missingSba.add('owner/second');const provider=state.provider;let creates=0;
  state.provider=async(request,context)=>{
    if(request.url==='https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/d1/database'&&request.method==='POST'){
      creates++;const body=await request.json();return Response.json({success:true,result:{uuid:'87654321-1234-1234-1234-123456789abc',name:body.name}});
    }
    return provider(request,context);
  };
  await ready(page);await page.locator('#service-add').click();await page.locator('[role=tab][data-repository="owner/repo"]').click();
  if(process.env.SUITE_TARGETS==='1')assert.equal(await page.locator('#service-platform').textContent(),'Cloudflare · GitHub Actions');
  assert.match(await page.locator('#service-environment').inputValue(),/^app-[a-f0-9]{12}$/);
  assert.equal(await page.locator('#service-inputs input, #service-resources select').count(),business?3:0);
  assert.equal(await page.locator('#service-inputs textarea').count(),1);
  if(business){
    const file=page.locator('#service-secret-file'),status=page.locator('#service-secret-import-status');
    const importFile=async value=>{await file.setInputFiles({name:'secrets.json',mimeType:'application/json',buffer:Buffer.from(value)});};
    await importFile(JSON.stringify(privateValues));await status.getByText('已导入 2 项',{exact:true}).waitFor();
    for(const [name,value]of Object.entries(privateValues))assert.equal(await page.locator('#service-secret-'+name).inputValue(),value);
    await importFile('{synthetic-private-parser-error');await status.getByText('秘密文件格式或内容不匹配',{exact:true}).waitFor();
    for(const [name,value]of Object.entries(privateValues))assert.equal(await page.locator('#service-secret-'+name).inputValue(),value,'invalid imports are atomic');
    assert.ok(!(await status.textContent()).includes('synthetic-private-parser-error'));
    await importFile(' '.repeat(32769));await status.getByText('秘密文件格式或内容不匹配',{exact:true}).waitFor();
    assert.equal(await file.inputValue(),'');
    assert.equal(requests.filter(row=>row.body?.action==='application-secrets').length,0,'import never submits secrets');
    await importFile(JSON.stringify(privateValues));await status.getByText('已导入 2 项',{exact:true}).waitFor();
    await page.evaluate(()=>{
      const read=File.prototype.text;
      File.prototype.text=function(){const selected=this;return new Promise(resolve=>{window.releaseSecretImport=async()=>{File.prototype.text=read;resolve(await read.call(selected));};});};
    });
    await importFile(JSON.stringify(privateValues));await status.getByText('正在导入…',{exact:true}).waitFor();
    await page.locator('#service-secret-profile').selectOption('');await page.evaluate(()=>window.releaseSecretImport());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await status.textContent(),'');
    for(const name of Object.keys(privateValues))assert.equal(await page.locator('#service-secret-'+name).inputValue(),'','stale import cannot repopulate fields');
    for(const [name,value]of Object.entries(privateValues))await page.locator('#service-secret-'+name).fill(value);
    assert.equal(await status.textContent(),'','manual secret entry remains available');
    await importFile(JSON.stringify(privateValues));await status.getByText('已导入 2 项',{exact:true}).waitFor();
    await page.locator('#service-close').click();
    await page.waitForFunction(()=>!document.getElementById('service-dialog').open && [...document.querySelectorAll('#service-inputs input[type=password]')].every(input=>!input.value));
    for(const name of Object.keys(privateValues))assert.equal(await page.locator('#service-secret-'+name).inputValue(),'','closing clears secrets');
    await page.locator('#service-add').click();await page.locator('[role=tab][data-repository="owner/repo"]').click();
    await importFile(JSON.stringify(privateValues));await status.getByText('已导入 2 项',{exact:true}).waitFor();
  }
  await page.locator('#service-field-1').fill('{');
  await page.locator('#service-submit').click();
  await page.getByText('JSON 配置格式不正确',{exact:true}).waitFor();
  assert.equal(creates,0);assert.equal(state.dispatches,0);
  const publicVars={CLOUDFLARE_SENDER_ADDRESS:'accounts@example.invalid'};
  await page.locator('#service-field-1').fill(JSON.stringify(publicVars));
  assert.equal(await page.locator('#service-resource-database').evaluate(el=>el.tagName),'OUTPUT');
  assert.equal(requests.some(row=>['inventory','discover','register'].includes(row.body?.action)),false);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:join(directory,`automatic-deploy-${width}.png`)});
  }
  await page.locator('#service-environment').fill('my-instance');
  assert.equal(await page.locator('#service-resource-database').textContent(),'my-instance-db');
  await reviewService(page);assert.equal(creates,0);assert.match(await page.locator('#service-review').textContent(),/my-instance-worker/);
  if(business){
    for(const [name,value]of Object.entries(privateValues)){
      assert.equal(await page.locator('#service-secret-'+name).inputValue(),'');
      assert.ok(!(await page.locator('#service-review').textContent()).includes(value));
      assert.ok(requests.filter(row=>row.path?.includes('/deployments/')).every(row=>!JSON.stringify(row.body).includes(value)));
    }
    assert.equal(requests.filter(row=>row.body?.action==='application-secrets').length,1);
  }
  await page.locator('#service-submit').click();await page.waitForFunction(()=>!document.getElementById('service-dialog').open);
  assert.equal(creates,1);assert.equal(state.dispatches,1);assert.equal(state.request.configuration.database.id,'87654321-1234-1234-1234-123456789abc');
  assert.deepEqual(state.request.configuration.vars,publicVars);
  if(process.env.SUITE_TARGETS==='1'){
    assert.equal(state.request.configuration.pages,'my-instance-pages');
    assert.equal(state.request.configuration.workflow,'.github/workflows/refresh.yml@my-instance');
    assert.equal(state.request.configuration.automation.repository,'owner/repo');
  }
  const permit=await(await machine()).json();if(business)for(const [name,value]of Object.entries(privateValues))assert.equal(permit.secrets[name],value);
  receipt(permit);await ready(page);await page.getByText('部署成功',{exact:true}).waitFor();
  await page.getByRole('button',{name:'升级',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#service-version option[value="'+'c'.repeat(40)+'"]'));
  await page.locator('#service-version').selectOption('c'.repeat(40));
  assert.equal(await page.locator('#service-field-1').isDisabled(),true);
  assert.deepEqual(JSON.parse(await page.locator('#service-field-1').inputValue()),publicVars);
  await reviewService(page);
  await page.locator('#service-submit').click();await page.waitForFunction(()=>!document.getElementById('service-dialog').open);
  assert.equal(creates,1,'updates never provision again');assert.equal(state.dispatches,2);assert.equal(state.request.action,'update');
  assert.equal(state.request.configuration.server.name,'my-instance-worker');assert.deepEqual(errors,[]);
  assert.deepEqual(state.request.configuration.vars,publicVars);
  if(business){assert.equal(requests.filter(row=>row.body?.action==='application-secrets').length,1);for(const value of Object.values(privateValues))assert.ok(!JSON.stringify(state.request).includes(value));}
  console.log('Automatic service deploy and retained-resource update passed (synthetic providers).');
}finally{await suite.close();}
