import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentFixture } from './deployment-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
test('fixed-SHA declaration produces source- and revision-bound public preview without dispatch',async()=>{
  const {f,state,input,post,resource}=await deploymentFixture();try{
    const app=await post({action:'application',github:input.github,sourceSha:input.sourceSha});assert.equal(app.status,200,app.text);assert.equal(app.json().repository,'owner/repo');
    const r=await post(input);assert.equal(r.status,200,r.text);const plan=r.json().plan;
    assert.equal(plan.configuration.accountId,'a'.repeat(32));assert.equal(plan.configuration.database.id,resource.remoteId);assert.equal(plan.policy.github.applicationRepository,'owner/repo');assert.equal(plan.policy.github.repository,'owner/executor');assert.equal(r.json().executionEnabled,false);
    assert.ok(!r.text.includes(fakeToken));assert.ok(state.requests.every(r=>r.method==='GET'));
    state.symlink=true;assert.equal((await post(input)).status,409);
  }finally{await f.close();}
});
test('preview rejects foreign/stale resources, changed connection, secrets and forged identity',async()=>{
  const {f,session,input,post}=await deploymentFixture();try{
    for(const patch of [{sourceSha:'main'},{owner:'forged'},{resources:{database:{id:input.resources.database.id,revision:9}}},{values:{...input.values,vars:{API_TOKEN:'secret'}}}])assert.equal((await post({...input,...patch})).status,409);
    assert.equal((await f.call('/api/admin/deployments/plan',{body:input})).status,403);
    assert.equal((await f.call('/api/admin/deployments/plan',{...session,token:f.jwt({sub:'other-owner'}),body:input})).status,403);
    await f.call('/api/admin/connections',{...session,body:{action:'disable',...input.cloudflare}});assert.equal((await post(input)).status,409);
  }finally{await f.close();}
});
