import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '../../cloud/access.mjs';
import { sbaDigest } from '../../cloud/sba-control.mjs';
import { zip } from '../sba-zip-fixture.mjs';
import { origin } from './admin-fixture.mjs';
import { sbaFixture as setup, policy, sha, sourceSha } from './sba-fixture.mjs';
test('authenticated preview → durable single dispatch → OIDC permit → verified artifact result', async t => {
  const x = await setup(t); assert.equal(x.adminState.sbaEnabled, true);
  assert.equal((await x.post('preview', { taskId: 'sba-test-task' }, { headers: {} })).status, 409);
  const plan = await x.preview(); assert.equal(x.state.dispatches, 0);
  assert.equal((await x.f.call('/api/admin/sba/state')).json().ready, true);
  const changed = structuredClone(plan); changed.plan.request.sourceSha = 'e'.repeat(40);
  assert.equal((await x.post('submit', changed)).status, 409);
  const forged = structuredClone(plan); forged.plan.manifest.actions.deploy.timeoutSeconds = 61;
  forged.confirmation = await signSession({ token: x.session, origin, actor: x.adminState.ownerId }, 'sba-confirm', [forged.plan, forged.expiresAt]);
  assert.equal((await x.post('submit', forged)).status, 409); assert.equal(x.state.dispatches, 0);
  const claims = await Promise.all([x.post('submit', plan), x.post('submit', plan)]);
  assert.ok(claims.every(r => r.status === 200)); assert.equal(x.state.dispatches, 1);
  await x.f.restart();
  assert.equal((await x.post('submit', plan)).status, 200); assert.equal(x.state.dispatches, 1);
  assert.equal((await x.permit(x.token({ workflow_sha: 'e'.repeat(40) }))).status, 403);
  x.state.badTitle = true; assert.equal((await x.permit()).status, 403); x.state.badTitle = false;
  assert.equal((await x.permit(x.token({ run_attempt: '2' }))).status, 403);
  const permits = await Promise.all([x.permit(), x.permit()]); assert.equal(permits.filter(r => r.status === 200).length, 1);
  const allowed = permits.find(r => r.status === 200).value;
  assert.deepEqual(allowed.secrets, { CLOUDFLARE_API_TOKEN: 'synthetic-deployment-secret' });
  assert.equal(allowed.requestDigest, await sbaDigest(allowed.request));
  assert.doesNotMatch((await x.f.call('/api/admin/sba/state')).text, /synthetic-deployment-secret|permitId|never-return/);
  await x.f.restart(); assert.equal((await x.permit()).status, 403);
  x.state.networkDown = true;
  assert.equal((await x.post('reconcile', { taskId: 'sba-test-task' })).status, 409);
  assert.equal((await x.f.call('/api/admin/sba/state')).json().job.status, 'running'); x.state.networkDown = false;
  const result = { schemaVersion: 2, taskId: allowed.request.taskId, action: 'deploy', sourceSha, applicationVersion: '1.0.0', status: 'succeeded', checks: [{ id: 'health-check', passed: true }] };
  x.state.archive = zip({ schemaVersion: 1, runId: 456, runAttempt: 1, executorSha: sha, requestDigest: allowed.requestDigest, permitId: allowed.permitId, result });
  x.state.runStatus = 'completed';
  assert.equal((await x.post('reconcile', { taskId: 'sba-test-task' })).json().job.status, 'succeeded');
  assert.equal((await x.post('reconcile', { taskId: 'sba-test-task' })).json().job.status, 'succeeded');
  assert.equal(x.state.dispatches, 1);
});
test('unknown dispatch can be bound by exact OIDC run without redispatch; machine host exposes no admin page', async t => {
  const x = await setup(t); x.state.dispatchLost = true;
  const plan = await x.preview(); assert.equal((await x.post('submit', plan)).json().job.status, 'dispatch-unknown');
  assert.equal((await x.post('submit', plan)).status, 200); assert.equal(x.state.dispatches, 1);
  assert.equal((await x.permit()).status, 200);
  for (const path of ['/', '/app.js', '/api/admin/state', '/node/poll'])
    assert.equal((await x.f.mf.dispatchFetch(policy.runnerOrigin + path)).status, 403);
  assert.equal((await x.permit(x.token(), undefined, origin + '/sba/v2/permit')).status, 403);
});
test('missing deployment secret rejects before permit consumption and disabled mode stays closed', async t => {
  const x = await setup(t, { SBA_APPLICATION_SECRETS: '{}' });
  const plan = await x.preview(); await x.post('submit', plan);
  assert.equal((await x.permit()).status, 403);
  assert.equal((await x.f.call('/api/admin/sba/state')).json().job.status, 'dispatched');
  const y = await setup(t, { ENABLE_SBA: 'no' }); assert.equal(y.adminState.sbaEnabled, false);
  assert.equal((await y.post('preview', { taskId: 'sba-test-task' })).status, 409);
  assert.equal((await y.permit()).status, 403); assert.equal(y.state.dispatches, 0);
});


test('source requires exact OIDC/task/run and can be reread without consuming the permit', async t => {
  const x = await setup(t);
  assert.equal((await x.source()).status, 403);
  await x.post('submit', await x.preview());
  for (const changes of [{ workflow_sha: 'e'.repeat(40) }, { run_attempt: '2' }, { run_id: '457' }]) {
    assert.equal((await x.source({ headers: { authorization: `Bearer ${x.token(changes)}`, 'content-type': 'application/json' } })).status, 403);
  }
  x.state.badTitle = true; assert.equal((await x.source()).status, 403); x.state.badTitle = false;
  for (const body of [{ taskId: 'different-task', requestDigest: x.state.requestDigest },
    { taskId: x.state.request.taskId, requestDigest: 'e'.repeat(64) },
    { taskId: x.state.request.taskId, requestDigest: x.state.requestDigest, repository: 'other/private' }])
    assert.equal((await x.source({ body: JSON.stringify(body) })).status, 403);
  assert.equal(x.state.sourceRequests, 0);
  for (let i = 0; i < 2; i++) {
    const response = await x.source(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'application/x-git-upload-pack-result');
    assert.equal(await response.text(), 'synthetic-source-bytes');
    assert.equal((await x.f.call('/api/admin/sba/state')).json().job.permitAt, null);
    await x.f.restart();
  }
  assert.equal(x.state.sourceRequests, 2); assert.equal(x.state.dispatches, 1);
  assert.equal((await x.permit()).status, 200);
  assert.equal((await x.source()).status, 403); assert.equal(x.state.sourceRequests, 2);
});

test('source stays closed for browser requests and upstream errors never consume a permit', async t => {
  const x = await setup(t, { SBA_APPLICATION_SECRETS: '{}' }); await x.post('submit', await x.preview());
  for (const [name, value] of [['cookie', 'private'], ['origin', origin]])
    assert.equal((await x.source({ headers: { authorization: `Bearer ${x.token()}`, 'content-type': 'application/json', [name]: value } })).status, 403);
  for (const path of [origin + '/sba/v2/source', policy.runnerOrigin + '/sba/v2/source?other=1'])
    assert.equal((await x.f.mf.dispatchFetch(path, { method: 'POST', body: '{}' })).status, 403);
  assert.equal(x.state.sourceRequests, 0);
  for (const status of [302, 500]) {
    x.state.sourceStatus = status;
    assert.equal((await x.source()).status, 403);
    assert.equal((await x.f.call('/api/admin/sba/state')).json().job.permitAt, null);
  }
  x.state.sourceStatus = 200;
  assert.equal((await x.source()).status, 200); // 读取代码不需要部署秘密。
  assert.equal((await x.permit()).status, 403); assert.equal(x.state.dispatches, 1);
});

test('admin recovery is CSRF protected, exact terminal-run checked, and never redispatches', async t => {
  const x = await setup(t); await x.post('submit', await x.preview());
  const body = { taskId: 'sba-test-task', executorSha: 'f'.repeat(40) };
  assert.equal((await x.post('recover-unstarted', body, { headers: {} })).status, 409);
  assert.equal((await x.post('recover-unstarted', body)).status, 409); // 仍运行。
  x.state.runStatus = 'completed';
  assert.equal((await x.post('recover-unstarted', body)).status, 409); // success 无未开始证明。
  x.state.conclusion = 'failure'; x.state.badTitle = true;
  assert.equal((await x.post('recover-unstarted', body)).status, 409);
  x.state.badTitle = false; x.state.networkDown = true;
  assert.equal((await x.post('recover-unstarted', body)).status, 409);
  x.state.networkDown = false;
  const response = await x.post('recover-unstarted', body);
  assert.equal(response.status, 200); assert.equal(response.json().outcome, 'not-executed');
  assert.equal(response.json().policyTransitionPending, true);
  assert.equal(x.state.dispatches, 1); assert.equal((await x.permit()).status, 403);
  await x.f.restart(); assert.equal((await x.f.call('/api/admin/sba/state')).status, 409);
});
test('a consumed permit can never be recovered even if GitHub later fails', async t => {
  const x = await setup(t); await x.post('submit', await x.preview()); assert.equal((await x.permit()).status, 200);
  x.state.runStatus = 'completed'; x.state.conclusion = 'failure';
  assert.equal((await x.post('recover-unstarted', { taskId: 'sba-test-task', executorSha: 'f'.repeat(40) })).status, 409);
  assert.equal((await x.f.call('/api/admin/sba/state')).json().job.status, 'running');
});
test('recovery defaults off and administrators cannot choose an unapproved executor', async t => {
  const x = await setup(t, { SBA_RECOVERY_EXECUTOR_SHA: '' }); await x.post('submit', await x.preview());
  x.state.runStatus = 'completed'; x.state.conclusion = 'failure';
  assert.equal((await x.post('recover-unstarted', { taskId: 'sba-test-task', executorSha: 'f'.repeat(40) })).status, 409);
  const y = await setup(t); await y.post('submit', await y.preview());
  y.state.runStatus = 'completed'; y.state.conclusion = 'failure';
  assert.equal((await y.post('recover-unstarted', { taskId: 'sba-test-task', executorSha: 'e'.repeat(40) })).status, 409);
  assert.equal((await y.f.call('/api/admin/sba/state')).json().job.permitAt, null);
});

test('machine rejection phases distinguish policy, OIDC, task, run and source without consuming permission', async t => {
  const x = await setup(t); await x.post('submit', await x.preview());
  const cases = [
    ['request', () => x.source({ headers: { authorization: `Bearer ${x.token()}`, origin } })],
    ['oidc', () => x.source({ headers: { authorization: `Bearer ${x.token({ workflow_sha: 'e'.repeat(40) })}` } })],
    ['body', () => x.source({ body: '{}' })],
    ['pending', () => x.source({ body: JSON.stringify({ taskId: 'different-task', requestDigest: x.state.requestDigest }) })],
    ['run', async () => { x.state.badTitle = true; try { return await x.source(); } finally { x.state.badTitle = false; } }],
    ['source', async () => { x.state.sourceStatus = 500; try { return await x.source(); } finally { x.state.sourceStatus = 200; } }],
  ];
  for (const [phase, call] of cases) {
    const response = await call(); assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-sba-denied-phase'), phase);
    if (phase === 'oidc') assert.equal(response.headers.get('x-sba-denied-reason'), 'executor');
    if (phase === 'source') {
      assert.equal(response.headers.get('x-sba-denied-reason'), 'http');
      assert.equal(response.headers.get('x-sba-upstream-status'), '500');
      assert.equal(response.headers.get('x-sba-upstream-media'), 'git');
    }
    const text = await response.text(); assert.equal(text, '{"error":"SBA_PERMIT_DENIED"}');
    assert.doesNotMatch(JSON.stringify([...response.headers]), /synthetic|Bearer|token\.actions/);
    assert.equal((await x.f.call('/api/admin/sba/state')).json().job.permitAt, null);
  }
  const disabled = await setup(t, { ENABLE_SBA: 'no' });
  assert.equal((await disabled.source()).headers.get('x-sba-denied-phase'), 'policy');
  assert.equal(x.state.dispatches, 1);
});
