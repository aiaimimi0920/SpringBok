import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {serviceBrowser,ready} from './service-fixture.mjs';
import {updatedSha} from '../cloud/service-fixture.mjs';
const suite=await serviceBrowser(),{page,service,input,github,submit,receipt,machine,state,errors}=suite;
const directory=process.env.UI_EVIDENCE_DIR??'test-results';await mkdir(directory,{recursive:true});
try {
  const first=(await service('plan',{...input,github,repository:'owner/repo'})).json();await submit(first);
  receipt(await(await machine()).json());await service('service-state',{instanceId:first.taskId,reconcile:true});
  const next=(await service('plan',{...input,github,repository:'owner/repo',sourceSha:updatedSha,instance:{id:first.taskId,previousTaskId:first.taskId}})).json();await submit(next);
  const original=state.provider;
  state.provider=async(request,context)=>{
    const response=await original(request,context);
    if(request.url.endsWith('/actions/runs/456'))return Response.json({...await response.json(),status:'completed',conclusion:'failure'});
    if(request.url.endsWith('/dispatches'))return Response.json({...await response.json(),workflow_run_id:789,run_url:'https://api.github.com/repos/owner/executor/actions/runs/789',html_url:'https://github.com/owner/executor/actions/runs/789'});
    return response;
  };
  await ready(page);const button=page.getByRole('button',{name:'恢复升级',exact:true});await button.click();
  const dialog=page.getByRole('dialog',{name:'恢复升级',exact:true}),confirm=dialog.getByRole('button',{name:'确认恢复升级',exact:true});
  await confirm.waitFor();await page.waitForFunction(()=>!document.querySelector('dialog[open] button.primary').disabled);
  assert.equal(state.dispatches,2);await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(state.dispatches,2);
  await button.click();await page.waitForFunction(()=>!document.querySelector('dialog[open] button.primary').disabled);
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(directory,`restart-update-${width}.png`)});}
  await confirm.click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(state.dispatches,3);assert.equal((await service('state',{taskId:next.taskId})).json().attempts.length,1);
  assert.deepEqual(errors,[]);console.log('unstarted update browser: cancellation, confirmation, 2 widths, one dispatch passed');
} finally {await suite.close();}
