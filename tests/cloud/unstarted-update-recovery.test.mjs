import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, updatedSha } from './service-fixture.mjs';

async function fixture() {
  const x = await serviceFixture(), { service, input, github, submit, receipt, machine, state } = x;
  const first = (await service('plan', { ...input, github, repository: 'owner/repo' })).json();
  await submit(first); receipt(await (await machine()).json());
  await service('service-state', { instanceId: first.taskId, reconcile: true });
  const next = (await service('plan', { ...input, github, repository: 'owner/repo', sourceSha: updatedSha,
    instance: { id: first.taskId, previousTaskId: first.taskId } })).json();
  await submit(next);
  const original = state.provider;
  state.failRun = true;
  state.provider = async (request, context) => {
    const url = request.url;
    if (/\/actions\/runs\/\d+$/.test(url) && !url.endsWith('/456')) {
      const response = await original(new Request(url.replace(/\/\d+$/, '/456'), request), context);
      const value = await response.json(); return Response.json({ ...value, id: Number(url.split('/').at(-1)), status: state.failRun?'completed':'in_progress', conclusion: state.failRun?'failure':null });
    }
    const response = await original(request, context);
    if (url.endsWith('/actions/runs/456') && state.failRun) return Response.json({ ...await response.json(), status: 'completed', conclusion: 'failure' });
    if (url.endsWith('/dispatches')) {const id=state.nextRunId=(state.nextRunId??788)+1;return Response.json({ ...await response.json(), workflow_run_id: id,
      run_url: 'https://api.github.com/repos/owner/executor/actions/runs/'+id, html_url: 'https://github.com/owner/executor/actions/runs/'+id });}
    return response;
  };
  return { ...x, first, next };
}

test('unstarted update restart preserves the exact request and old proof, dispatches once and rejects old run', async () => {
  const { f, next, api, state, token, machine, session } = await fixture();
  try {
    const request = structuredClone(state.request), plan = await api('restart-plan', { taskId: next.taskId });
    assert.equal(plan.status, 200, plan.text);
    const { instance, ...body } = plan.json();
    const results = await Promise.all([api('restart-submit', body), api('restart-submit', body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(state.dispatches, 3);
    assert.deepEqual(state.request, request);
    const current = (await api('state', { taskId: next.taskId })).json().job;
    assert.equal(current.runId, 789); assert.equal(current.permitAt, null); assert.equal(current.result, null);
    assert.equal((await machine()).status, 403);
    await f.restart();
    const history=(await api('state',{taskId:next.taskId})).json().attempts;
    assert.equal(history.length,1);assert.equal(history[0].job.runId,456);assert.equal(history[0].job.permitAt,null);
    assert.equal(history[0].outcome,'not-executed');assert.equal(history[0].proof.conclusion,'failure');
    const locks=await f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    const owner=(await f.call('/api/admin/state',session)).json().ownerId;
    await assert.rejects(locks.get(locks.idFromName('deployment-account/v1/'+'a'.repeat(32))).claim(owner,'dc-'+'f'.repeat(32),'a'.repeat(32),'other/repo/testing',[],'d'.repeat(64)),'recovery must retain the original account lane');
    state.failRun=false;
    const permit = await machine('permit', { headers: { authorization: `Bearer ${token({ run_id: '789' })}`, 'content-type': 'application/json' } });
    assert.equal(permit.status, 200);
    assert.equal((await api('restart-submit', body)).status, 409);
    assert.equal((await api('restart-plan', { taskId: next.taskId })).status, 409);
    assert.equal((await f.call('/api/admin/deployments/restart-plan', { ...session, headers: {}, body: { taskId: next.taskId } })).status, 403);
  } finally { await f.close(); }
});

test('three recovery attempts are retained and a fourth cannot dispatch',async()=>{
  const {f,next,api,state}=await fixture();
  try{
    for(let n=0;n<3;n++){
      const plan=await api('restart-plan',{taskId:next.taskId});assert.equal(plan.status,200,plan.text);
      const {instance,...body}=plan.json();assert.equal((await api('restart-submit',body)).status,200);
    }
    await f.restart();assert.equal((await api('state',{taskId:next.taskId})).json().attempts.length,3);
    assert.equal((await api('restart-plan',{taskId:next.taskId})).status,409);assert.equal(state.dispatches,5);
  }finally{await f.close();}
});

test('restart requires owner CSRF, exact terminal failure and current confirmation', async () => {
  const { f, next, first, api, state, session } = await fixture();
  try {
    assert.equal((await api('restart-plan', { taskId: first.taskId })).status, 409);
    state.failRun = false; state.runStatus = 'in_progress';
    assert.equal((await api('restart-plan', { taskId: next.taskId })).status, 409);
    state.failRun = true;
    const { instance, ...body } = (await api('restart-plan', { taskId: next.taskId })).json();
    for (const patch of [{ digest: '0'.repeat(64) }, { runId: 999 }, { expiresAt: 1 }, { confirmation: 'forged' }])
      assert.equal((await api('restart-submit', { ...body, ...patch })).status, 409);
    const token = f.jwt({ sub: 'other-owner' }), other = (await f.call('/api/admin/state', { token })).json();
    assert.equal((await f.call('/api/admin/deployments/restart-plan', { token, headers: { 'x-csrf-token': other.csrf }, body: { taskId: next.taskId } })).status, 409);
    assert.equal((await f.call('/api/admin/deployments/restart-submit', { ...session, headers: {}, body })).status, 403);
    assert.equal(state.dispatches, 2);
  } finally { await f.close(); }
});

test('lost new dispatch cannot be replayed and disabling execution rejects confirmation', async () => {
  const {f,next,api,state,machine}=await fixture();
  try {
    const {instance,...body}=(await api('restart-plan',{taskId:next.taskId})).json();
    f.bindings.ENABLE_CONNECTED_DEPLOYMENTS='no';await f.restart();
    assert.equal((await api('restart-submit',body)).status,409);assert.equal(state.dispatches,2);
    f.bindings.ENABLE_CONNECTED_DEPLOYMENTS='yes';await f.restart();state.dispatchLost=true;
    const response=await api('restart-submit',body);assert.equal(response.status,200,response.text);
    assert.equal(response.json().job.status,'dispatch-unknown');assert.equal(response.json().job.runId,null);
    assert.equal((await api('restart-submit',body)).status,409);
    assert.equal((await api('restart-plan',{taskId:next.taskId})).status,409);
    assert.equal((await machine()).status,403);assert.equal(state.dispatches,3);
    const ns=await f.mf.getDurableObjectNamespace('CONNECTED_TASKS'),stub=ns.get(ns.idFromName('connected/v1/'+next.taskId));
    await assert.rejects(stub.permit(next.taskId,body.digest,456),'old in-flight permit is fenced even while new run ID is unknown');
    await f.restart();assert.equal((await api('state',{taskId:next.taskId})).json().attempts.length,1);
  } finally {await f.close();}
});
