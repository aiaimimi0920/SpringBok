import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectedFixture } from './connected-fixture.mjs';
import { declaration } from './deployment-fixture.mjs';
import { previewFixture } from './preview-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';

const account = 'a'.repeat(32), task = () => 'dc-' + randomUUID().replaceAll('-', '');
async function fixture() {
  const value = await connectedFixture(), { state, input, f, auth } = value, provider = state.provider;
  state.resources = null; state.creates = 0;
  state.declaration = { ...structuredClone(declaration), schemaVersion: 2, accountMode: 'single',
    accounts: [{ key: 'runtime', label: '账户', path: ['accountId'], secret: 'CLOUDFLARE_API_TOKEN' }],
    fields: declaration.fields.map(row => ({ ...row, template: row.type === 'text' ? '{instance}-worker' : null })),
    resources: declaration.resources.map(row => ({ ...row, account: 'runtime', nativeAccount: 'runtime', nameTemplate: '{instance}-db' })),
    targets: declaration.targets.map(row => ({ ...row, account: 'runtime' })) };
  input.values = { vars: { issuer: 'https://accounts.example.com' } }; input.resources = {};
  state.provider = async (request, context) => {
    if (request.url.endsWith('/d1/database') && request.method === 'POST') {
      state.creates++; const body = await request.json();
      if (state.failCreate) return new Response(null, { status: 503 });
      return Response.json({ success: true, result: { name: body.name, uuid: '87654321-1234-1234-1234-123456789abc' } });
    }
    return provider(request, context);
  };
  const vault = () => f.mf.getDurableObjectNamespace('CONNECTIONS').then(ns => ns.get(ns.idFromName('connections/v1/' + auth.ownerId)));
  const locks = () => f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS').then(ns => ns.get(ns.idFromName('deployment-account/v1/' + account)));
  const claim = async (id, keys = []) => (await locks()).claim(auth.ownerId, id, account, 'other/repo/' + id, keys, 'd'.repeat(64));
  const reserve = async () => {
    const blocker = task(); await claim(blocker);
    const plan = await value.preview(); assert.equal((await value.submit(plan)).status, 409);
    await (await locks()).release(blocker); return plan;
  };
  const confirmation = async id => { const result = await value.api('resume-plan', { taskId: id }); assert.equal(result.status, 200, result.text); const { instance, ...body } = result.json(); return body; };
  return { ...value, vault, locks, claim, reserve, confirmation };
}

test('declared ownership permits shared external issuer but refuses a claimed worker', async () => {
  const x = await fixture();
  try {
    const prior = task(); await x.claim(prior, ['identity:https://accounts.example.com']); await (await x.locks()).release(prior);
    const plan = await x.preview(); assert.equal((await x.submit(plan)).status, 200); assert.equal(x.state.creates, 1);
  } finally { await x.f.close(); }
  const y = await fixture();
  try {
    const prior = task(); await y.claim(prior, ['identity:testing-worker']); await (await y.locks()).release(prior);
    assert.equal((await y.submit(await y.preview())).status, 409); assert.equal(y.state.creates, 0); assert.equal(y.state.dispatches, 0);
  } finally { await y.f.close(); }
});

test('reserved recovery is owner/CSRF/digest/expiry bound and consumes once across concurrent requests and restart', async () => {
  const x = await fixture();
  try {
    const plan = await x.reserve(); await x.f.restart();
    const state = await x.api('service-state', { instanceId: plan.taskId, reconcile: true }); assert.equal(state.json().canResume, true);
    assert.equal((await x.f.call('/api/admin/deployments/resume-plan', { token: x.session.token, body: { taskId: plan.taskId } })).status, 403);
    const foreign = x.f.jwt({ sub: 'foreign' }), auth = (await x.f.call('/api/admin/state', { token: foreign })).json();
    assert.equal((await x.f.call('/api/admin/deployments/resume-plan', { token: foreign, headers: { 'x-csrf-token': auth.csrf }, body: { taskId: plan.taskId } })).status, 409);
    const body = await x.confirmation(plan.taskId);
    for (const patch of [{ digest: 'f'.repeat(64) }, { expiresAt: 1 }, { expiresAt: Date.now() + 500000 }, { confirmation: 'forged' }, { plan: {} }]) assert.equal((await x.api('resume-submit', { ...body, ...patch })).status, 409);
    assert.equal(x.state.creates, 0);
    const results = await Promise.all([x.api('resume-submit', body), x.api('resume-submit', body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(x.state.creates, 1); assert.equal(x.state.dispatches, 1);
    assert.equal(x.state.request.taskId, plan.taskId); assert.equal(x.state.request.sourceSha, plan.plan.application.sourceSha);
    await x.f.restart(); assert.equal((await x.api('resume-submit', body)).status, 409);
    assert.equal((await x.submit(plan)).status, 200); assert.equal(x.state.creates, 1); assert.equal(x.state.dispatches, 1);
    const row = (await (await x.vault()).deploymentIndex(x.auth.ownerId)).find(row => row.taskId === plan.taskId);
    assert.deepEqual(row.preparation.intent, plan.plan); assert.equal(row.preparation.phase, 'ready'); assert.ok(row.preparation.recovery.id);
  } finally { await x.f.close(); }
});

test('recovery fence denies the original in-flight provision and a second recovery after restart', async () => {
  const x = await fixture();
  try {
    const plan = await x.reserve(), id = randomUUID();
    await (await x.vault()).beginPreparationRecovery(x.auth.ownerId, plan.taskId, plan.plan.digest, id);
    await assert.rejects((await x.vault()).provisionDeployment(x.auth.ownerId, plan.taskId, plan.plan));
    await assert.rejects((await x.vault()).provisionDeployment(x.auth.ownerId, plan.taskId, plan.plan, randomUUID()));
    await x.f.restart(); assert.equal((await x.api('resume-plan', { taskId: plan.taskId })).status, 409);
    await (await x.vault()).provisionDeployment(x.auth.ownerId, plan.taskId, plan.plan, id);
    await assert.rejects((await x.vault()).provisionDeployment(x.auth.ownerId, plan.taskId, plan.plan, id)); assert.equal(x.state.creates, 1);
  } finally { await x.f.close(); }
});

test('provider creation failure remains unknown and cannot be resumed', async () => {
  const x = await fixture();
  try {
    const plan = await x.reserve(), body = await x.confirmation(plan.taskId); x.state.failCreate = true;
    assert.equal((await x.api('resume-submit', body)).status, 409); assert.equal(x.state.creates, 1);
    await x.f.restart(); assert.equal((await x.api('resume-plan', { taskId: plan.taskId })).status, 409);
    const state = (await x.api('service-state', { instanceId: plan.taskId, reconcile: true })).json();
    assert.equal(state.preparation.phase, 'unknown'); assert.equal(state.canResume, false); assert.equal(x.state.dispatches, 0);
  } finally { await x.f.close(); }
});

test('released claim cannot be revived by an identical task', async () => {
  const x = await fixture();
  try {
    const id = task(); await x.claim(id); await x.claim(id); await (await x.locks()).release(id);
    await assert.rejects(x.claim(id)); await x.claim(task()); await assert.rejects(x.claim(id));
  } finally { await x.f.close(); }
});

test('creating, ready, unknown, nonempty resources and existing bootstrap never qualify for recovery', async () => {
  const x = await fixture();
  try {
    const plan = await x.reserve();
    for (const patch of [{ phase: 'creating' }, { phase: 'unknown' }, { phase: 'ready' }, { phase: 'reserved', resources: { database: { status: 'creating' } } }]) {
      await (await x.vault()).patchPreparation(plan.taskId, patch);
      assert.equal((await x.api('resume-plan', { taskId: plan.taskId })).status, 409);
    }
    await (await x.vault()).patchPreparation(plan.taskId, { phase: 'reserved', resources: {} });
    const ns = await x.f.mf.getDurableObjectNamespace('CONNECTED_TASKS');
    await ns.get(ns.idFromName('connected/v1/' + plan.taskId)).initialize(x.auth.ownerId, plan.taskId, plan.plan);
    assert.equal((await x.api('resume-plan', { taskId: plan.taskId })).status, 409);
    assert.equal(x.state.creates, 0); assert.equal(x.state.dispatches, 0);
  } finally { await x.f.close(); }
});

test('stale connection and retained account lane reject recovery before resource creation', async () => {
  const x = await fixture();
  try {
    const plan = await x.reserve(), body = await x.confirmation(plan.taskId);
    await x.f.call('/api/admin/connections', { ...x.session, body: { action: 'disable', id: x.input.cloudflare.id, revision: 1 } });
    assert.equal((await x.api('resume-submit', body)).status, 409); assert.equal(x.state.creates, 0);
  } finally { await x.f.close(); }
  const y = await fixture();
  try {
    const plan = await y.reserve(), body = await y.confirmation(plan.taskId); await y.claim(task());
    assert.equal((await y.api('resume-submit', body)).status, 409); assert.equal(y.state.creates, 0);
    assert.equal((await y.api('resume-plan', { taskId: plan.taskId })).status, 409);
  } finally { await y.f.close(); }
});

test('uninitialized single-account service update blocked by account-lane-busy waits for lane release and resumes once', async () => {
  const f = await previewFixture();
  try {
    const first = (await f.service('plan', f.input)).json();
    assert.equal((await f.submit(first)).status, 200);
    f.complete(await (await f.machine()).json());
    assert.equal((await f.service('service-state', { instanceId: first.taskId, reconcile: true })).json().canUpdate, true);
    assert.equal(f.state.created.length, 1);

    const ns = await f.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS');
    const locks = ns.get(ns.idFromName('deployment-account/v1/' + account));
    const blocker = task();
    await locks.claim(f.auth.ownerId, blocker, account, 'other/repo/concurrent', [], 'd'.repeat(64));

    const update = (await f.service('plan', { ...f.input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } })).json();
    const blocked = await f.submit(update);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json().error, 'account-lane-busy');
    assert.equal(f.state.dispatches, 1);

    const unconfirmed = (await f.service('service-state', { instanceId: first.taskId, reconcile: true })).json();
    assert.equal(unconfirmed.status, 'preparation-unconfirmed');
    assert.equal(unconfirmed.canUpdate, false);
    assert.equal(unconfirmed.canResume, true);

    // While the concurrent service still holds the account lane, resume-plan rejects with account-lane-busy without consuming recovery.
    const busyPlan = await f.service('resume-plan', { taskId: update.taskId });
    assert.equal(busyPlan.status, 409);
    assert.equal(busyPlan.json().error, 'account-lane-busy');
    assert.equal((await f.service('service-state', { instanceId: first.taskId, reconcile: true })).json().canResume, true);

    await locks.release(blocker);
    await f.f.restart();
    const confirmation = await f.service('resume-plan', { taskId: update.taskId });
    assert.equal(confirmation.status, 200, confirmation.text);
    const { instance, ...body } = confirmation.json();
    assert.equal(instance.id, first.taskId);
    assert.equal(instance.action, 'update');
    assert.equal(instance.application.sourceSha, updatedSha);

    const outcomes = await Promise.all([f.service('resume-submit', body), f.service('resume-submit', body)]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    assert.equal(f.state.created.length, 1);
    assert.equal(f.state.dispatches, 2);
    assert.equal(f.state.request.taskId, update.taskId);
    assert.equal(f.state.request.action, 'update');
    assert.equal(f.state.request.sourceSha, updatedSha);
    assert.equal((await f.service('resume-plan', { taskId: update.taskId })).status, 409);

    f.complete(await (await f.machine()).json());
    const finalState = (await f.service('service-state', { instanceId: first.taskId, reconcile: true })).json();
    assert.equal(finalState.job.status, 'succeeded');
    assert.equal(finalState.instance.application.version, '2.0.0');
    assert.equal(finalState.canUpdate, true);
  } finally { await f.f.close(); }
});
