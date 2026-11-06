import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './service-fixture.mjs';
import { deletionProvider } from './service-deletion-fixture.mjs';

async function unknownDeletion() {
  const s = await serviceFixture();
  const plan = (await s.service('plan', s.input)).json();
  assert.equal((await s.submit(plan)).status, 200);
  s.receipt(await (await s.machine()).json());
  await s.service('service-state', { instanceId: plan.taskId, reconcile: true });
  const live = deletionProvider(s), review = (await s.service('delete-plan', { instanceId: plan.taskId, previousTaskId: plan.taskId })).json();
  live.lost = true;
  const original = (await s.service('delete-submit', { ...review, acceptUnverifiedReferences: false })).json();
  assert.equal(original.status, 'delete-unknown');
  return { ...s, live, original, input: { instanceId: plan.taskId, operationId: review.operationId } };
}
test('read-only deletion reconciliation preserves unknown and its lane while any resource remains or cannot be read', async () => {
  const s = await unknownDeletion();
  try {
    await s.f.restart();
    const pending = await s.service('delete-reconcile', s.input);
    assert.equal(pending.status, 200, pending.text);
    assert.equal(pending.json().status, 'delete-unknown');
    assert.equal(pending.json().reconciliation.status, 'incomplete');
    assert.equal(pending.json().errorCode, s.original.errorCode);
    assert.equal(pending.json().resources.find(r => r.kind === 'worker').status, 'unknown');
    s.live.databaseReadError = true;
    const failed = await s.service('delete-reconcile', s.input);
    assert.equal(failed.status, 200, failed.text);
    assert.equal(failed.json().status, 'delete-unknown');
    assert.equal(failed.json().reconciliation.status, 'unconfirmed');
    const ns = await s.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    const locks = ns.get(ns.idFromName('deployment-account/v1/' + 'a'.repeat(32)));
    await assert.rejects(locks.claimDeletion(s.auth.ownerId, s.input.instanceId, 'dc-' + 'e'.repeat(32), 'a'.repeat(32), ['test-worker'], 'e'.repeat(64)));
    assert.equal(s.live.deletes.length, 2);
  } finally { await s.f.close(); }
});
test('only independently absent original inventory finishes its original claim, survives restart and keeps failure and deployment history', async () => {
  const s = await unknownDeletion();
  try {
    s.live.database = false;
    const result = await s.service('delete-reconcile', s.input);
    assert.equal(result.status, 200, result.text);
    const done = result.json();
    assert.equal(done.status, 'deleted');
    assert.equal(done.operationId, s.original.operationId);
    assert.equal(done.digest, s.original.digest);
    assert.equal(done.errorCode, s.original.errorCode);
    assert.deepEqual(done.resources, s.original.resources);
    assert.equal(done.reconciliation.status, 'absent');
    assert.equal(done.reconciliation.previousStatus, 'delete-unknown');
    await s.f.restart();
    assert.deepEqual((await s.service('delete-reconcile', s.input)).json(), done);
    const state = (await s.service('service-state', { instanceId: s.input.instanceId, reconcile: true })).json();
    assert.equal(state.status, 'deleted');
    assert.equal(state.canReconcileDeletion, false);
    assert.equal(state.history.length, 1);
    assert.equal(state.job.status, 'succeeded');
    const resources = (await s.f.call('/api/admin/resources', s.session)).json();
    assert.equal(resources.resources.some(r => r.remoteId === s.resource.remoteId), false);
    assert.equal(s.live.deletes.length, 2);
    const ns = await s.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    const finished = await ns.get(ns.idFromName('deployment-account/v1/' + 'a'.repeat(32))).finishDeletion(s.auth.ownerId, s.input.instanceId, done.operationId, done.digest);
    assert.equal(await finished.released, true);
  } finally { await s.f.close(); }
});
test('reconciliation refuses CSRF, another owner, a different operation and caller-supplied inventory without cloud deletion', async () => {
  const s = await unknownDeletion();
  try {
    const call = body => s.service('delete-reconcile', body);
    assert.equal((await s.f.call('/api/admin/deployments/delete-reconcile', { ...s.session, headers: {}, body: s.input })).status, 403);
    assert.equal((await call({ ...s.input, operationId: 'dc-' + 'f'.repeat(32) })).status, 409);
    assert.equal((await call({ ...s.input, resources: [] })).status, 409);
    const token = s.f.jwt({ sub: 'another-owner' }), auth = (await s.f.call('/api/admin/state', { token })).json();
    assert.equal((await s.f.call('/api/admin/deployments/delete-reconcile', { token, headers: { 'x-csrf-token': auth.csrf }, body: s.input })).status, 409);
    const state = (await s.service('service-state', { instanceId: s.input.instanceId, reconcile: true })).json();
    assert.equal(state.canReconcileDeletion, true);
    assert.equal(s.live.deletes.length, 2);
  } finally { await s.f.close(); }
});
