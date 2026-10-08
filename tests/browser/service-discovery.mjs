import assert from 'node:assert/strict';
import { serviceBrowser, ready } from './service-fixture.mjs';
const suite = await serviceBrowser(), {page, f, state, session, input, auth, errors, requests} = suite;
let release, captured;
const blocked = new Promise(resolve => { captured = resolve; });
try {
  await page.clock.install();
  const disabled = await f.call('/api/admin/connections', {...session, body:{action:'disable', id:input.github.id, revision:input.github.revision}});
  assert.equal(disabled.status,200,disabled.text);
  const repos=Array.from({length:42},(_,i)=>({id:100+i,full_name:'owner/empty-'+i,default_branch:'main'}));
  repos.push({id:2,full_name:'owner/repo',default_branch:'main'});
  state.missingSba = new Set(repos.slice(0,42).map(row=>row.full_name));
  state.repositoryPages=[repos.slice(0,20),repos.slice(20,40),repos.slice(40)];
  let active=0, maxActive=0;
  auth.intercept=async route=>{
    if (!route.request().url().endsWith('/application')) return false;
    const body=route.request().postDataJSON();
    active++;maxActive=Math.max(maxActive,active);
    try {
      if(body.repository==='owner/empty-0') {
        await new Promise(resolve=>{release=resolve;captured();});
        await route.fulfill({status:409,contentType:'application/json',body:'{"error":"synthetic-slow-repository"}'});
      } else {
        const response=await f.mf.dispatchFetch(route.request().url(),{method:'POST',headers:{...route.request().headers(),'cf-access-jwt-assertion':auth.token},body:route.request().postData()});
        await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
      }
      return true;
    } finally {active--;}
  };
  await ready(page); await page.locator('#service-add').click(); await blocked;
  await page.locator('[role=tab][data-repository="owner/repo"]').waitFor({timeout:10000});
  assert.ok(maxActive>1 && maxActive<=4,'a global bounded queue scans past a slow first repository');
  await page.waitForFunction(()=>document.getElementById('service-catalog-status').textContent.includes('已检查 42/43'));
  assert.match(await page.locator('#service-catalog-status').textContent(),/已检查 42\/43/);
  assert.equal(state.dispatches,0);
  await page.locator('#service-close').click(); await page.locator('#service-add').click();
  assert.equal(requests.filter(row=>row.path.endsWith('/catalog')).length,3,'reopening does not launch a second scan');
  await page.clock.fastForward(45001);
  await page.waitForFunction(()=>!document.getElementById('service-catalog-status').textContent.includes('正在'));
  assert.match(await page.locator('#service-catalog-status').textContent(),/读取失败.*owner\/empty-0/);
  assert.equal(await page.locator('#service-tabs button').count(),1);
  assert.equal(await page.locator('#service-loading').textContent(),'','a timed out read does not leave the loading indicator stuck');
  assert.equal(requests.some(row=>['register','discover','use-repository'].includes(row.body?.action)),false);
  assert.deepEqual(errors,[]);
  release();release=null;
  console.log('PASS SV-02 discovery: one account, 43 repositories over three pages, slow first repository does not block later services, bounded concurrency, close/reopen, timeout settlement and visible progress/failure, zero deployment writes');
} finally {release?.();await suite.close();}
