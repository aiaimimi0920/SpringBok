import test from 'node:test';
import assert from 'node:assert/strict';
import { suiteFixture } from './suite-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';

async function absentSuite(repository) {
  const s = await suiteFixture();
  if (repository) s.input.repository = repository;
  const first = await s.preview();
  await s.submit(first); s.complete(await (await s.machine()).json());
  await s.service('service-state', { instanceId: first.taskId, reconcile: true });
  const prior = s.state.provider, live = { present: false, denied: false, incomplete: false, writes: [] };
  s.state.provider = async (request, context) => {
    const url = new URL(request.url);
    if (request.method !== 'GET') live.writes.push(request.url);
    if (url.pathname.includes('/d1/database/') && request.method === 'GET') return live.denied ? Response.json({}, { status: 403 }) : Response.json(live.present ? { success: true, errors: [], result: { uuid: s.state.created[0].id, name: 'testing-db' } } : { success: false, errors: [{ code: 7404 }], result: null }, { status: live.present ? 200 : 404 });
    if (url.pathname.endsWith('/workers/scripts')) return Response.json({ success: true, result: [] });
    if (url.pathname.endsWith('/pages/projects/testing-pages')) return Response.json({ success: false, result: null, errors: [{ code: 8000007 }] }, { status: 404 });
    if (url.pathname.endsWith('/environments')) return Response.json({ total_count: live.incomplete ? 1 : 0, environments: [] });
    if (url.pathname.includes('/actions/workflows/') && url.pathname.endsWith('/runs')) return Response.json({ total_count: 0, workflow_runs: [] });
    return prior(request, context);
  };
  return { ...s, first, live, identity: { instanceId: first.taskId, previousTaskId: first.taskId } };
}

test('absent suite retirement changes only active projection, preserves history/claims and survives restart', async () => {
  const s = await absentSuite();
  try {
    const current = (await s.service('plan', { ...s.input, environment: 'current' })).json();
    assert.equal((await s.submit(current)).status, 200);
    s.complete(await (await s.machine()).json());
    await s.service('service-state', { instanceId: current.taskId, reconcile: true });
    s.live.writes.length = 0;
    const nsBefore = await s.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    const locksBefore = nsBefore.get(nsBefore.idFromName('deployment-account/v1/' + 'a'.repeat(32)));
    // An unrelated held/unknown execution lane must remain held across retirement.
    await locksBefore.claim(s.auth.ownerId, 'dc-' + 'd'.repeat(32), 'a'.repeat(32), 'held/unknown/env', [], 'd'.repeat(64));
    const before = (await s.service('service-state', { instanceId: s.first.taskId, reconcile: false })).json();
    const review = await s.service('retire-plan', s.identity);
    assert.equal(review.status, 200, review.text);
    assert.deepEqual(review.json().plan.resources.map(row => row.kind), ['d1', 'worker', 'pages', 'github-actions']);
    const retired = await s.service('retire-submit', review.json());
    assert.equal(retired.status, 200, retired.text);
    assert.equal(retired.json().status, 'retired');
    assert.deepEqual(s.live.writes, []);
    assert.equal(s.state.dispatches, 2);
    await s.f.restart();
    assert.deepEqual((await s.service('retire-submit', review.json())).json(), retired.json());
    assert.deepEqual((await s.service('services')).json().services.map(row => row.id), [current.taskId]);
    const after = (await s.service('service-state', { instanceId: s.first.taskId, reconcile: false })).json();
    assert.equal(after.status, 'retired');
    assert.deepEqual(after.job, before.job); assert.deepEqual(after.history, before.history);
    assert.equal(after.canUpdate, false); assert.equal(after.canVerify, false);
    assert.equal((await s.service('verify', s.identity)).status, 409);
    assert.equal((await s.service('plan', { ...s.input, sourceSha: updatedSha, instance: { id: s.first.taskId, previousTaskId: s.first.taskId } })).status, 409);
    // Original ownership remains: registration retirement is not finishDeletion.
    const ns = await s.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    const locks = ns.get(ns.idFromName('deployment-account/v1/' + 'a'.repeat(32)));
    await assert.rejects(locks.claim(s.auth.ownerId, 'dc-' + 'c'.repeat(32), 'a'.repeat(32), 'another/env', [], 'c'.repeat(64)));
    await assert.rejects(locks.claim('f'.repeat(64), 'dc-' + 'e'.repeat(32), 'a'.repeat(32), 'foreign/app/env', ['identity:testing-worker'], 'e'.repeat(64)));
    assert.equal((await s.service('state', { taskId: s.first.taskId })).status, 200);
  } finally { await s.f.close(); }
});

test('retirement accepts canonical Actions scope for mixed-case repository', async () => {
  const s = await absentSuite('owner/Repo');
  try {
    const state = (await s.service('service-state', { instanceId: s.first.taskId, reconcile: false })).json();
    assert.equal(state.canRetire, true);
    const review = await s.service('retire-plan', s.identity);
    assert.equal(review.status, 200, review.text);
    assert.equal(review.json().plan.instance.application.repository, 'owner/Repo');
    assert.equal((await s.service('retire-submit', review.json())).status, 200);
    assert.deepEqual(s.live.writes, []);
  } finally { await s.f.close(); }
});

test('retirement binds same-ID current verified revisions without rewriting history', async () => {
  const s = await absentSuite();
  try {
    const before = (await s.service('service-state', { instanceId: s.first.taskId, reconcile: false })).json();
    const ref = before.instance.connections.cloudflare;
    const verify = revision => s.f.call('/api/admin/connections', { ...s.session, body: { action: 'verify', id: ref.id, revision } });
    assert.equal((await verify(1)).status, 200);
    const review = await s.service('retire-plan', s.identity);
    assert.equal(review.status, 200, review.text);
    assert.deepEqual(review.json().plan.connections.cloudflare, { id: ref.id, revision: 2 });
    assert.deepEqual(review.json().plan.instance.connections, before.instance.connections);
    assert.equal((await verify(2)).status, 200);
    assert.equal((await s.service('retire-submit', review.json())).status, 409);
    const fresh = await s.service('retire-plan', s.identity);
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal((await s.service('retire-submit', fresh.json())).status, 200);
    const after = (await s.service('service-state', { instanceId: s.first.taskId, reconcile: false })).json();
    assert.deepEqual(after.instance.connections, before.instance.connections);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(s.live.writes, []);
  } finally { await s.f.close(); }
});

for (const state of ['failed', 'disabled']) test(`retirement rejects current ${state} connection`, async () => {
  const s = await absentSuite();
  try {
    const ref = s.input.cloudflare;
    if (state === 'failed') s.state.reject = true;
    const response = await s.f.call('/api/admin/connections', { ...s.session, body: { action: state === 'failed' ? 'verify' : 'disable', id: ref.id, revision: 1 } });
    assert.equal(response.status, 200, response.text);
    s.state.reject = false;
    assert.equal((await s.service('retire-plan', s.identity)).status, 409);
    assert.equal((await s.service('services')).json().services.length, 1);
  } finally { await s.f.close(); }
});

test('retirement rejects present, denied, incomplete, stale or tampered proof and CSRF without writes', async () => {
  const s = await absentSuite();
  try {
    s.live.present = true; assert.equal((await s.service('retire-plan', s.identity)).status, 409);
    s.live.present = false; s.live.denied = true; assert.equal((await s.service('retire-plan', s.identity)).status, 409);
    s.live.denied = false; s.live.incomplete = true; assert.equal((await s.service('retire-plan', s.identity)).status, 409);
    s.live.incomplete = false;
    assert.equal((await s.service('retire-plan', { ...s.identity, previousTaskId: 'dc-' + 'f'.repeat(32) })).status, 409);
    const review = (await s.service('retire-plan', s.identity)).json();
    assert.equal((await s.f.call('/api/admin/deployments/retire-submit', { ...s.session, headers: {}, body: review })).status, 403);
    const changed = structuredClone(review); changed.plan.resources = [];
    assert.equal((await s.service('retire-submit', changed)).status, 409);
    s.live.present = true; assert.equal((await s.service('retire-submit', review)).status, 409);
    assert.equal((await s.service('services')).json().services.length, 1);
    assert.deepEqual(s.live.writes, []); assert.equal(s.state.dispatches, 1);
  } finally { await s.f.close(); }
});
