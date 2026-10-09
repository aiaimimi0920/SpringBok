import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
const suite=await serviceBrowser(),{page,state,preview,submit,machine,receipt,api,errors}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
try{
  const plan=await preview();assert.equal((await submit(plan)).status,200);
  receipt(await(await machine()).json(),'unknown',{errorCode:'NACCOUNT_READINESS_FAILED'});
  await api('reconcile',{taskId:plan.taskId});await ready(page);
  await page.getByText('结果未确认',{exact:true}).waitFor();
  state.runStatus='in_progress';await page.getByRole('button',{name:'验证可用性',exact:true}).click();
  await page.getByText('验证中',{exact:true}).waitFor();assert.equal(state.dispatches,2);assert.equal(state.request.action,'verify');
  const permit=await(await machine()).json();assert.equal(permit.secrets.CLOUDFLARE_API_TOKEN,'verification-not-applicable');receipt(permit);
  await ready(page);await page.getByText('可用性已验证',{exact:true}).waitFor();
  await page.getByRole('button',{name:'详情',exact:true}).click();
  assert.equal(await page.getByText('NACCOUNT_READINESS_FAILED',{exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'升级',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
  assert.equal(await page.getByText('结果未确认',{exact:true}).count(),1);
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,`service-verify-${width}.png`)});}
  assert.deepEqual(errors,[]);console.log('Independent verification status, immutable failure history, controls and narrow layout passed.');
}finally{await suite.close();}
