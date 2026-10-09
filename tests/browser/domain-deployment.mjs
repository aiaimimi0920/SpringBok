import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready, reviewService } from './service-fixture.mjs';
const suite=await serviceBrowser(),{page,state,errors,f,input,session,requests}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
try{
  const d=structuredClone(state.declaration);d.schemaVersion=2;d.accountMode='single';
  d.accounts=[{key:'runtime',label:'账户',path:['accountId'],secret:'CLOUDFLARE_API_TOKEN'}];
  d.fields=d.fields.map(field=>({...field,template:field.type==='text'?'{instance}-worker':null}));
  const manual=process.env.DOMAIN_MANUAL_FIELD==='1';
  d.fields.push({path:['server','url'],label:'认证地址',type:'text',required:true,template:manual?null:'https://{instance}.{subdomain:runtime}.workers.dev'});
  d.resources=d.resources.map(row=>({...row,account:'runtime',nativeAccount:'runtime',nameTemplate:'{instance}-db'}));
  d.targets=d.targets.map(target=>({...target,account:'runtime'}));d.targets.push({kind:'domain',path:['server','url'],account:'runtime'});
  state.declaration=d;state.resources=null;state.missingSba.add('owner/second');
  const provider=state.provider,zoneId='d'.repeat(32),account='a'.repeat(32);let creates=0;
  state.provider=async(request,context)=>{
    const url=new URL(request.url);
    if(url.origin==='https://api.cloudflare.com'){
      if(url.pathname.startsWith('/client/v4/zones')){
        assert.equal(request.method,'GET');const zone={id:zoneId,name:'example.com',status:'active',account:{id:account}};
        if(url.pathname.endsWith('/dns_records'))return Response.json({success:true,result:[],result_info:{total_count:0}});
        return Response.json({success:true,result:url.pathname.endsWith('/zones')?[zone]:zone});
      }
      if(url.pathname.endsWith('/workers/subdomain'))return Response.json({success:true,result:{subdomain:'test'}});
      if(url.pathname.endsWith('/d1/database')&&request.method==='POST'){creates++;const body=await request.json();return Response.json({success:true,result:{uuid:'87654321-1234-1234-1234-123456789abc',name:body.name}});}
    }
    return provider(request,context);
  };
  const listing=await f.call('/api/admin/resources',{...session,body:{action:'discover',connectionId:input.cloudflare.id,kind:'zone',cursor:''}});
  assert.equal(listing.status,200);
  const saved=await f.call('/api/admin/resources',{...session,body:{action:'register',connectionId:input.cloudflare.id,kind:'zone',listingId:listing.json().id,resourceId:zoneId}});
  assert.equal(saved.status,200);const zone=saved.json().resource;
  await ready(page);await page.locator('#service-add').click();await page.locator('[role=tab][data-repository="owner/repo"]').click();
  await page.locator('#service-cloudflare').selectOption(input.cloudflare.id);
  assert.equal(await page.locator('#service-subdomain-0').isDisabled(),true);
  await page.locator('#service-zone-0').selectOption(zone.id);await page.locator('#service-subdomain-0').fill('accounts');
  if(manual){
    const field=page.getByLabel('认证地址',{exact:true});assert.equal(await field.isDisabled(),true);
    await page.locator('#service-zone-0').selectOption('');assert.equal(await field.isDisabled(),false);
    await page.locator('#service-zone-0').selectOption(zone.id);assert.equal(await field.isDisabled(),true);
  }
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,`domain-deploy-${width}.png`)});}
  await reviewService(page);assert.ok((await page.locator('#service-review dd').allTextContents()).includes('https://accounts.example.com'));assert.equal(creates,0);
  const planRequest=requests.findLast(row=>row.path.endsWith('/plan'));
  assert.deepEqual(planRequest.body.domains,{'server.url':{resource:{id:zone.id,revision:zone.revision},subdomain:'accounts'}});
  assert.equal(Object.hasOwn(planRequest.body.values,'server.url'),false);
  await page.locator('#service-close').click();assert.equal(creates,0);assert.equal(state.dispatches,0);
  await page.locator('#service-add').click();await page.locator('[role=tab][data-repository="owner/repo"]').click();await page.locator('#service-cloudflare').selectOption(input.cloudflare.id);
  await page.locator('#service-zone-0').selectOption(zone.id);await page.locator('#service-subdomain-0').fill('accounts');await reviewService(page);
  await page.locator('#service-submit').click();await page.waitForFunction(()=>!document.getElementById('service-dialog').open);
  assert.equal(creates,1);assert.equal(state.dispatches,1);assert.equal(state.request.configuration.server.url,'https://accounts.example.com');
  assert.equal(Object.values(state.request.configuration).some(value=>value?.kind==='zone'),false);assert.deepEqual(errors,[]);
  console.log('Registered Zone selection, cancellation and custom-domain deployment passed (synthetic providers).');
}finally{await suite.close();}
