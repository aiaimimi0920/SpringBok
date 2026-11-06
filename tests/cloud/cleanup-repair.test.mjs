import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFixture } from './preview-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';

async function setup(status = 'failed', partial = false, authenticatedProgress = false) {
  const f = await previewFixture({ ENABLE_SERVICE_REPAIR: 'yes' });
  const first = (await f.service('plan', f.input)).json(); await f.submit(first);
  f.complete(await (await f.machine()).json()); await f.service('service-state', { instanceId: first.taskId, reconcile: true });
  const copy = (await f.service('plan', { action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId,
    sourceSha: updatedSha, environment: 'test-123456789abc' })).json(); await f.submit(copy);
  f.complete(await (await f.machine()).json()); await f.service('service-state', { instanceId: copy.taskId, reconcile: true });
  const remove = (await f.service('plan', { action: 'destroy-preview', instanceId: copy.taskId, previousTaskId: copy.taskId })).json();
  await f.submit(remove); const permit = await (await f.machine()).json();
  f.receipt(permit, status, { checks: authenticatedProgress ? ['preview-authority-verified', 'preview-ingress-stopped'].map(id => ({ id, passed: true })) : [], errorCode: 'SHARED_OR_UNVERIFIED', ...(partial ? { lifecycle: {
    resources: permit.request.context.resources.map(row => ({ key: row.key, status: 'unknown' })) } } : {}) });
  const failed = (await f.service('service-state', { instanceId: copy.taskId, reconcile: true })).json();
  f.state.updateVersion = '3.0.0'; f.state.manifestOverride = { ...f.state.manifestOverride,
    actions: { ...f.state.manifestOverride.actions, repair: { timeoutSeconds: 300 } },
    repairs: [{ id: 'cleanup-copy', name: '清理测试副本', fromErrorCodes: ['SHARED_OR_UNVERIFIED'],
      fromActions: ['destroy-preview', 'repair'], secretNames: ['CLOUDFLARE_API_TOKEN'] }] };
  return { ...f, first, copy, remove, failed, body: { action: 'repair', instanceId: copy.taskId,
    previousTaskId: remove.taskId, sourceSha: '5'.repeat(40), repairId: 'cleanup-copy' } };
}

test('authenticated prewrite cleanup failure uses a new bounded repair and retains both histories', async () => {
  const f = await setup();
  try {
    assert.equal(f.failed.job.status, 'failed'); assert.equal(f.failed.canRepair, true); assert.equal(f.failed.canDeletePreview, false);
    const reply = await f.service('plan', f.body); assert.equal(reply.status, 200, reply.text); const next = reply.json();
    assert.deepEqual(next.plan.operation.context.cleanup, { sourceSha: updatedSha, applicationVersion: '2.0.0', context: f.failed.job.request.context });
    assert.deepEqual(next.plan.resources, f.remove.plan.resources); assert.deepEqual(next.plan.configuration, f.failed.configuration);
    assert.equal((await f.submit(next)).status, 200); assert.equal((await f.submit(next)).status, 200);
    assert.equal(f.state.dispatches, 4); assert.equal(f.state.created.length, 2);
    const permit = await (await f.machine()).json(); assert.equal((await f.machine()).status, 403);
    await f.f.restart();
    f.receipt(permit, 'succeeded', { checks: [{ id: 'repair-completed', passed: true }], lifecycle: {
      resources: permit.request.context.cleanup.context.resources.map(row => ({ key: row.key, status: 'removed' })) } });
    const done = (await f.service('service-state', { instanceId: f.copy.taskId, reconcile: true })).json();
    assert.equal(done.status, 'deleted'); assert.equal(done.canRepair, false); assert.equal(done.canDeletePreview, false);
    assert.deepEqual(done.testUrls, []); assert.equal(done.history.length, 3);
    assert.deepEqual((await f.api('state', { taskId: f.remove.taskId })).json().job, f.failed.job);
    assert.equal((await f.service('service-state', { instanceId: f.first.taskId, reconcile: false })).json().history.length, 1);
  } finally { await f.f.close(); }
});

test('partial cleanup needs candidate opt-in and derives evidence twice, retaining the consumed parent and original lane', async () => {
  const f = await setup('unknown', true, true);
  try {
    assert.equal(f.failed.canRepair, true);
    assert.equal((await f.service('plan', f.body)).status, 409);
    f.state.manifestOverride.repairs[0].resumeCleanup = true;
    f.state.runStatus = 'in_progress'; assert.equal((await f.service('plan', f.body)).status, 409);
    f.state.runStatus = 'completed';
    const response = await f.service('plan', f.body); assert.equal(response.status, 200, response.text);
    const next = response.json(), progress = next.plan.operation.context.cleanupProgress;
    assert.equal(progress.consumedTaskId, f.remove.taskId); assert.equal(progress.permitAt, f.failed.job.permitAt);
    assert.equal(progress.journalTaskId, null); assert.deepEqual(progress.parentResult, f.failed.job.result);
    for (const mutate of [p => p.permitAt++, p => p.consumedTaskId = f.copy.taskId,
      p => p.journalTaskId = f.copy.taskId, p => p.parentResult.checks.pop()]) {
      const changed = structuredClone(next); mutate(changed.plan.operation.context.cleanupProgress);
      assert.equal((await f.submit(changed)).status, 409);
    }
    assert.equal((await f.submit(next)).status, 200); assert.equal((await f.submit(next)).status, 200);
    const permit = await (await f.machine()).json(); assert.equal((await f.machine()).status, 403);
    f.receipt(permit, 'unknown', { checks: [{ id: 'cleanup-resume-claim-persisted', passed: true }], errorCode: 'SHARED_OR_UNVERIFIED',
      lifecycle: { resources: f.failed.job.result.lifecycle.resources } });
    await f.service('service-state', { instanceId: f.copy.taskId, reconcile: true });
    await f.f.restart(); f.state.updateVersion = '4.0.0';
    const reply = await f.service('plan', { ...f.body, previousTaskId: next.taskId, sourceSha: '6'.repeat(40) });
    assert.equal(reply.status, 200, reply.text); const last = reply.json();
    assert.deepEqual(last.plan.operation.context.cleanup, next.plan.operation.context.cleanup);
    assert.equal(last.plan.operation.context.cleanupProgress.consumedTaskId, f.remove.taskId);
    assert.equal(last.plan.operation.context.cleanupProgress.permitAt, progress.permitAt);
    assert.equal(last.plan.operation.context.cleanupProgress.journalTaskId, next.taskId);
    assert.equal((await f.submit(last)).status, 200); const finalPermit = await (await f.machine()).json();
    f.receipt(finalPermit, 'succeeded', { checks: [{ id: 'repair-completed', passed: true }], lifecycle: {
      resources: f.failed.job.result.lifecycle.resources.map(row => ({ ...row, status: 'absent' })) } });
    const done = (await f.service('service-state', { instanceId: f.copy.taskId, reconcile: true })).json();
    assert.equal(done.status, 'deleted'); assert.equal(f.state.dispatches, 5); assert.equal(f.state.created.length, 2);
    assert.deepEqual((await f.api('state', { taskId: f.remove.taskId })).json().job, f.failed.job);
  } finally { await f.f.close(); }
});

test('unknown or any reported partial cleanup is not recoverable, even with a declared repair', async () => {
  for (const [status, partial] of [['unknown', false], ['failed', true]]) {
    const f = await setup(status, partial);
    try {
      assert.equal(f.failed.canRepair, false); assert.equal((await f.service('plan', f.body)).status, 409);
      assert.equal(f.state.dispatches, 3); assert.equal(f.state.created.length, 2);
    } finally { await f.f.close(); }
  }
});

test('cleanup recovery rejects stale or client-supplied evidence and requires the exact authenticated parent action', async () => {
  const f = await setup();
  try {
    assert.equal((await f.service('plan', { ...f.body, context: {} })).status, 409);
    assert.equal((await f.service('plan', { ...f.body, previousTaskId: f.copy.taskId })).status, 409);
    f.state.manifestOverride.repairs[0].fromActions = ['repair'];
    assert.equal((await f.service('plan', f.body)).status, 409);
    f.state.manifestOverride.repairs[0].fromActions = ['destroy-preview', 'repair'];
    f.state.runStatus = 'in_progress'; assert.equal((await f.service('plan', f.body)).status, 409);
    assert.equal(f.state.dispatches, 3); assert.equal(f.state.created.length, 2);
  } finally { await f.f.close(); }
});

test('a second prewrite cleanup repair inherits the original cleanup release, never the failed candidate', async () => {
  const f = await setup();
  try {
    const first = (await f.service('plan', f.body)).json(); assert.equal((await f.submit(first)).status, 200);
    const permit = await (await f.machine()).json();
    f.receipt(permit, 'failed', { checks: [], errorCode: 'SHARED_OR_UNVERIFIED' });
    await f.service('service-state', { instanceId: f.copy.taskId, reconcile: true });
    f.state.updateVersion = '4.0.0';
    const response = await f.service('plan', { ...f.body, previousTaskId: first.taskId, sourceSha: '6'.repeat(40) });
    assert.equal(response.status, 200, response.text); const next = response.json();
    assert.deepEqual(next.plan.operation.context.cleanup, first.plan.operation.context.cleanup);
    assert.deepEqual(next.plan.operation.previous, { sourceSha: '5'.repeat(40), applicationVersion: '3.0.0' });
    const changed = structuredClone(next); changed.plan.operation.context.cleanup.context.resultDigest = '0'.repeat(64);
    assert.equal((await f.submit(changed)).status, 409);
    assert.equal((await f.submit(next)).status, 200); assert.equal(f.state.dispatches, 5); assert.equal(f.state.created.length, 2);
    assert.deepEqual((await (await f.machine()).json()).request.context.cleanup, first.plan.operation.context.cleanup);
  } finally { await f.f.close(); }
});
