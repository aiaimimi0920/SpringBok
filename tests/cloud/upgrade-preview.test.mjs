import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFixture } from './preview-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';
const stateBody = instanceId => ({ instanceId, reconcile: true });
async function deployed(f) {
  const first = (await f.service('plan', f.input)).json(); assert.equal((await f.submit(first)).status, 200);
  f.complete(await (await f.machine()).json());
  assert.equal((await f.service('service-state', stateBody(first.taskId))).json().canUpdate, true);
  return first;
}
const draft = first => ({ action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, environment: 'test-123456789abc' });

test('preview forks a persistent isolated instance, binds the source, and cleanup preserves production and history', async () => {
  const f = await previewFixture();
  try {
    const first = await deployed(f), original = structuredClone(f.state.request), planResponse = await f.service('plan', draft(first));
    assert.equal(planResponse.status, 200, planResponse.text); const plan = planResponse.json();
    assert.equal(f.state.created.length, 1); assert.equal(plan.plan.operation.action, 'preview');
    const outcomes = await Promise.all([f.submit(plan), f.submit(plan)]); assert.ok(outcomes.every(row => row.status === 200), JSON.stringify(outcomes));
    assert.equal(f.state.dispatches, 2); assert.equal(f.state.created.length, 2);
    assert.equal(f.state.request.action, 'preview'); assert.deepEqual(f.state.request.context.source.configuration, original.configuration);
    assert.notEqual(f.state.request.configuration.database.id, original.configuration.database.id);
    assert.notEqual(f.state.request.configuration.server.name, original.configuration.server.name);
    const permit = await (await f.machine()).json(); await f.f.restart(); f.complete(permit);
    const preview = (await f.service('service-state', stateBody(plan.taskId))).json();
    assert.equal(preview.canDeletePreview, true); assert.equal(preview.canUpdate, false); assert.equal(preview.canPreview, false); assert.equal(preview.testUrls.length, 1);
    const parent = (await f.service('service-state', stateBody(first.taskId))).json(); assert.equal(parent.history.length, 1); assert.equal(parent.job.request.applicationVersion, '1.0.0'); assert.deepEqual(parent.configuration, original.configuration);
    assert.equal((await f.service('services')).json().services.length, 2);
    // 正式更新是独立任务，仍以原数据配置和最新线上回执为依据。
    const update = (await f.service('plan', { ...f.input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } })).json();
    assert.equal((await f.submit(update)).status, 200); assert.equal(f.state.request.action, 'update'); assert.deepEqual(f.state.request.configuration, original.configuration);
    f.complete(await (await f.machine()).json()); await f.service('service-state', stateBody(first.taskId));
    const removeResponse = await f.service('plan', { action: 'destroy-preview', instanceId: plan.taskId, previousTaskId: plan.taskId });
    assert.equal(removeResponse.status, 200, removeResponse.text); const remove = removeResponse.json();
    assert.equal((await f.submit(remove)).status, 200); assert.equal(f.state.request.action, 'destroy-preview');
    assert.equal(Object.hasOwn(f.state.request.context, 'source'), false, 'cleanup must not pass production configuration');
    assert.ok(f.state.request.context.resources.every(row => row.remoteId !== original.configuration.database.id && row.remoteId !== original.configuration.server.name && row.remoteId !== original.configuration.url));
    f.complete(await (await f.machine()).json()); await f.f.restart();
    const deleted = (await f.service('service-state', stateBody(plan.taskId))).json(); assert.equal(deleted.status, 'deleted'); assert.equal(deleted.canDeletePreview, false); assert.deepEqual(deleted.testUrls, []); assert.equal(deleted.history.length, 2);
    assert.equal((await f.submit(remove)).status, 200); assert.equal(f.state.dispatches, 4); assert.equal(f.state.created.length, 2);
    const production = (await f.service('service-state', stateBody(first.taskId))).json(); assert.equal(production.job.request.applicationVersion, '2.0.0'); assert.deepEqual(production.configuration, original.configuration);
  } finally { await f.f.close(); }
});
test('production cleanup, stale sources, unsupported applications and non-isolated targets are rejected before cloud writes', async () => {
  const f = await previewFixture();
  try {
    const first = await deployed(f), body = draft(first);
    assert.equal((await f.service('plan', { action: 'destroy-preview', instanceId: first.taskId, previousTaskId: first.taskId })).status, 409);
    for (const patch of [{ sourceSha: f.input.sourceSha }, { environment: 'testing' }, { instanceId: 'dc-' + '0'.repeat(32) }, { previousTaskId: 'dc-' + '0'.repeat(32) }, { extra: true }]) assert.equal((await f.service('plan', { ...body, ...patch })).status, 409);
    const before = structuredClone(f.state.manifestOverride);
    f.state.manifestOverride = {}; assert.equal((await f.service('plan', body)).status, 409); f.state.manifestOverride = before;
    f.state.updateDeclaration = { fields: f.state.declaration.fields.map(field => ({ ...field, template: null })) };
    assert.equal((await f.service('plan', body)).status, 409); f.state.updateDeclaration = null;
    assert.equal(f.state.created.length, 1); assert.equal(f.state.dispatches, 1);
    const candidate = (await f.service('plan', body)).json();
    const update = (await f.service('plan', { ...f.input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } })).json(); await f.submit(update);
    assert.equal((await f.submit(candidate)).status, 409); assert.equal(f.state.created.length, 1);
  } finally { await f.f.close(); }
});
test('preview ownership cannot be fabricated by a provider returning a production database ID', async () => {
  const f = await previewFixture();
  try {
    const first = await deployed(f); f.state.reuseSourceId = true;
    const plan = (await f.service('plan', draft(first))).json(); assert.equal((await f.submit(plan)).status, 409);
    assert.equal(f.state.dispatches, 1); await f.f.restart();
    assert.equal((await f.submit(plan)).status, 200); assert.equal(f.state.created.length, 2);
    assert.equal((await f.service('service-state', stateBody(plan.taskId))).json().status, 'preparation-unconfirmed');
    assert.equal((await f.service('service-state', stateBody(first.taskId))).json().job.status, 'succeeded');
  } finally { await f.f.close(); }
});
test('partial cleanup and uncertain preview receipts remain visible and cannot be replayed or called deleted', async () => {
  for (const cleanup of [false, true]) {
    const f = await previewFixture();
    try {
      const first = await deployed(f), plan = (await f.service('plan', draft(first))).json(); await f.submit(plan);
      f.complete(await (await f.machine()).json(), cleanup ? 'succeeded' : 'unknown');
      const state = (await f.service('service-state', stateBody(plan.taskId))).json(); assert.equal(state.canDeletePreview, cleanup);
      if (cleanup) {
        const remove = (await f.service('plan', { action: 'destroy-preview', instanceId: plan.taskId, previousTaskId: plan.taskId })).json(); await f.submit(remove);
        f.complete(await (await f.machine()).json(), 'unknown', { lifecycle: { resources: f.state.request.context.resources.map((row, i) => ({ key: row.key, status: i === 0 ? 'removed' : 'unknown' })) } });
      }
      await f.f.restart(); const current = (await f.service('service-state', stateBody(plan.taskId))).json();
      assert.equal(current.job.status, 'unknown'); assert.equal(current.canDeletePreview, false); assert.notEqual(current.status, 'deleted');
      assert.equal((await f.service('plan', { action: 'destroy-preview', instanceId: plan.taskId, previousTaskId: current.taskId })).status, 409);
      assert.equal((await f.service('service-state', stateBody(first.taskId))).json().job.request.applicationVersion, '1.0.0');
    } finally { await f.f.close(); }
  }
});
