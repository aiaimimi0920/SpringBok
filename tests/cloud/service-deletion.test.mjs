import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture, updatedSha } from './service-fixture.mjs';
import { deletionProvider } from './service-deletion-fixture.mjs';
import { importFixture } from './service-import-fixture.mjs';

async function deployed() {
  const s = await serviceFixture();
  const plan = (await s.service('plan', s.input)).json(); assert.equal((await s.submit(plan)).status, 200);
  s.receipt(await (await s.machine()).json(), 'deployed-unverified');
  const state = (await s.service('service-state', { instanceId: plan.taskId, reconcile: true })).json(); assert.equal(state.canDelete, true);
  return { ...s, initial: plan, live: deletionProvider(s), body: { instanceId: plan.taskId, previousTaskId: plan.taskId } };
}
test('ordinary deletion confirms exact inventory, deletes provider resources once, verifies absence, preserves history and survives restart', async () => {
  const s = await deployed();
  try {
    const p = await s.service('delete-plan', s.body); assert.equal(p.status, 200, p.text); const review = p.json();
    assert.equal(review.plan.resources.length, 3); assert.equal(s.live.deletes.length, 0);
    const done = await s.service('delete-submit', review); assert.equal(done.status, 200, done.text); assert.equal(done.json().status, 'deleted', done.text);
    assert.deepEqual(s.live.deletes, ['/workers/domains/' + 'd'.repeat(32), '/workers/scripts/test-worker', '/d1/database/' + s.resource.remoteId]);
    assert.equal((await s.service('delete-submit', review)).json().status, 'deleted'); assert.equal(s.live.deletes.length, 3);
    await s.f.restart(); const state = (await s.service('service-state', { instanceId: s.initial.taskId, reconcile: true })).json();
    assert.equal(state.status, 'deleted'); assert.equal(state.canDelete, false); assert.equal(state.canUpdate, false); assert.equal(state.history.length, 1);
    assert.equal(state.job.status, 'deployed-unverified'); assert.equal(s.state.dispatches, 1);
    assert.equal((await s.service('plan', s.input)).status, 409, 'deleted resource registration is no longer selectable');
    assert.equal((await s.service('delete-plan', s.body)).status, 409);
    assert.equal((await s.service('plan', { ...s.input, sourceSha: updatedSha, instance: { id: s.initial.taskId, previousTaskId: s.initial.taskId } })).status, 409);
  } finally { await s.f.close(); }
});
test('imported service and KV can be deleted with exact claims; deleted import cannot silently reclaim a recreated identity', async () => {
  const s = await importFixture();
  try {
    s.state.importBindings.push({ name: 'KV', type: 'kv_namespace', namespace_id: '1'.repeat(32) });
    const draft = (await s.service('import-preview', s.draft)).json();
    const saved = await s.service('import-submit', draft); assert.equal(saved.status, 200, saved.text);
    const live = deletionProvider(s); live.kv = true;
    const review = await s.service('delete-plan', { instanceId: saved.json().instance.id, previousTaskId: null }); assert.equal(review.status, 200, review.text);
    const done = await s.service('delete-submit', review.json()); assert.equal(done.json().status, 'deleted', done.text); assert.equal(live.kv, false);
    live.worker = true; live.database = true; live.kv = true;
    assert.equal((await s.service('import-preview', s.draft)).status, 409);
    const ns = await s.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'), locks = ns.get(ns.idFromName('deployment-account/v1/' + 'a'.repeat(32)));
    const c = draft.candidate, keys = [...new Set([...Object.values(c.instance.resources).flatMap(r => [r.remoteId, r.name]), ...c.instance.targets.map(r => r.value)])];
    await assert.rejects(locks.registerImported(s.auth.ownerId, c.id, c.instance.accountId, keys, { id: c.instance.application.id, repository: c.instance.application.repository }));
  } finally { await s.f.close(); }
});
test('shared references, stale metadata, missing CSRF, tampered confirmation and owner mismatch cause zero cloud writes', async () => {
  const s = await deployed();
  try {
    s.live.shared = true; assert.equal((await s.service('delete-plan', s.body)).status, 409); s.live.shared = false;
    s.live.pagesShared = true; assert.equal((await s.service('delete-plan', s.body)).status, 409); s.live.pagesShared = false;
    s.live.pagesDeployments = [{ uses_functions: true }]; assert.equal((await s.service('delete-plan', s.body)).status, 409);
    s.live.pagesDeployments = [{ uses_functions: true, d1_databases: { DB: { id: s.resource.remoteId } } }]; assert.equal((await s.service('delete-plan', s.body)).status, 409); s.live.pagesDeployments = null;
    const review = (await s.service('delete-plan', s.body)).json();
    assert.equal((await s.f.call('/api/admin/deployments/delete-submit', { ...s.session, headers: {}, body: review })).status, 403);
    assert.equal((await s.service('delete-submit', { ...review, confirmation: 'bad' })).status, 409);
    const altered = structuredClone(review); altered.plan.resources[0].remoteId = 'e'.repeat(32); assert.equal((await s.service('delete-submit', altered)).status, 409);
    s.live.modified = '2026-10-09T00:00:00Z'; assert.equal((await s.service('delete-submit', review)).status, 409);
    const token = s.f.jwt({ sub: 'another-owner' }), auth = (await s.f.call('/api/admin/state', { token })).json();
    assert.equal((await s.f.call('/api/admin/deployments/delete-plan', { token, headers: { 'x-csrf-token': auth.csrf }, body: s.body })).status, 409);
    assert.deepEqual(s.live.deletes, []);
  } finally { await s.f.close(); }
});
test('lost DELETE response persists partial progress and never replays after duplicate submit or restart', async () => {
  const s = await deployed();
  try {
    const review = (await s.service('delete-plan', s.body)).json(); s.live.lost = true;
    const done = (await s.service('delete-submit', review)).json(); assert.equal(done.status, 'delete-unknown');
    assert.equal(done.resources.find(r => r.kind === 'domain').status, 'removed'); assert.equal(done.resources.find(r => r.kind === 'worker').status, 'unknown');
    assert.equal(s.live.database, true); await s.f.restart();
    assert.equal((await s.service('delete-submit', review)).json().status, 'delete-unknown'); assert.equal(s.live.deletes.length, 2);
    const state = (await s.service('service-state', { instanceId: s.initial.taskId, reconcile: true })).json(); assert.equal(state.canUpdate, false); assert.equal(state.canDelete, false);
    assert.equal((await s.service('delete-plan', s.body)).status, 409);
  } finally { await s.f.close(); }
});
test('competing confirmations cannot delete twice; a confirmed new update invalidates an older delete plan', async () => {
  const s = await deployed();
  try {
    const a = (await s.service('delete-plan', s.body)).json(), b = (await s.service('delete-plan', s.body)).json();
    const results = await Promise.all([s.service('delete-submit', a), s.service('delete-submit', b)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(s.live.deletes.length, 3);
  } finally { await s.f.close(); }
  const t = await deployed();
  try {
    const review = (await t.service('delete-plan', t.body)).json();
    const update = (await t.service('plan', { ...t.input, sourceSha: updatedSha, instance: { id: t.initial.taskId, previousTaskId: t.initial.taskId } })).json();
    assert.equal((await t.submit(update)).status, 200);
    assert.equal((await t.service('delete-submit', review)).status, 409); assert.equal(t.live.deletes.length, 0);
  } finally { await t.f.close(); }
});
test('automatic same-name rebuild obtains fresh resource IDs after deletion without changing old receipts', async () => {
  const s = await serviceFixture();
  try {
    const d = structuredClone(s.state.declaration); d.schemaVersion = 2; d.accountMode = 'single';
    d.accounts = [{ key: 'runtime', label: '账户', path: ['accountId'], secret: 'CLOUDFLARE_API_TOKEN' }];
    d.fields = d.fields.map(f => ({ ...f, template: f.type === 'text' ? 'test-worker' : null }));
    d.resources = d.resources.map(r => ({ ...r, account: 'runtime', nativeAccount: 'runtime', nameTemplate: '{instance}-db' }));
    d.targets = d.targets.map(t => ({ ...t, account: 'runtime' })); s.state.declaration = d;
    const input = { ...s.input, values: {}, resources: {} }, prior = s.state.provider; let count = 0;
    s.state.resources = null;
    s.state.provider = async (request, context) => {
      if (request.method === 'POST' && request.url.endsWith('/d1/database')) {
        count++; const body = await request.json(); s.resource.remoteId = (count === 1 ? '87654321' : '87654322') + '-1234-1234-1234-123456789abc'; s.resource.name = body.name;
        return Response.json({ success: true, result: { uuid: s.resource.remoteId, name: body.name } });
      }
      return prior(request, context);
    };
    const first = (await s.service('plan', input)).json(); assert.equal((await s.submit(first)).status, 200);
    s.receipt(await (await s.machine()).json()); await s.service('service-state', { instanceId: first.taskId, reconcile: true });
    const live = deletionProvider(s);
    const review = (await s.service('delete-plan', { instanceId: first.taskId, previousTaskId: first.taskId })).json();
    assert.equal((await s.service('delete-submit', review)).json().status, 'deleted');
    const second = (await s.service('plan', input)).json(); assert.notEqual(second.taskId, first.taskId);
    const submitted = await s.submit(second); assert.equal(submitted.status, 200, submitted.text); assert.equal(count, 2);
    assert.equal(s.state.request.configuration.database.id, '87654322-1234-1234-1234-123456789abc');
    s.receipt(await (await s.machine()).json()); live.worker = true; live.database = true;
    assert.equal((await s.service('service-state', { instanceId: second.taskId, reconcile: true })).json().canDelete, true);
    assert.equal((await s.service('service-state', { instanceId: first.taskId, reconcile: true })).json().status, 'deleted');
    const nextReview = (await s.service('delete-plan', { instanceId: second.taskId, previousTaskId: second.taskId })).json();
    assert.equal((await s.service('delete-submit', nextReview)).json().status, 'deleted'); assert.equal(live.deletes.length, 5);
  } finally { await s.f.close(); }
});
