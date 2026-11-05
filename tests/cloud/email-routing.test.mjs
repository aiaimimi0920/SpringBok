import test from 'node:test';
import assert from 'node:assert/strict';
import { emailRoutingFixture, zoneId } from './email-routing-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';
import { deletionProvider } from './service-deletion-fixture.mjs';

test('email target is zone-exclusive, optional, linked to a declared Worker and preflight is read-only', async () => {
  const s = await emailRoutingFixture();
  try {
    const response = await s.service('plan', s.input); assert.equal(response.status, 200, response.text);
    const target = response.json().plan.application.declaration.targets.at(-1); assert.equal(target.kind, 'email-routing');
    for (const patch of [{ zoneId: 'invalid', domain: 'example.invalid' }, { zoneId, domain: 'sub.example.invalid' }, { zoneId, domain: 'https://example.invalid' }]) {
      assert.equal((await s.service('plan', { ...s.input, values: { routing: patch } })).status, 409);
    }
    s.live.zoneAccount = 'b'.repeat(32); assert.equal((await s.service('plan', s.input)).status, 409); s.live.zoneAccount = 'a'.repeat(32);
    s.live.ready = false; assert.equal((await s.service('plan', s.input)).status, 409); s.live.ready = true;
    s.activate(); assert.equal((await s.submit(response.json())).status, 409, 'submit re-reads catch-all; even an identically named Worker is not adopted');
    assert.deepEqual(s.live.writes, []); assert.equal(s.state.dispatches, 0); assert.equal(s.state.created.length, 0);
    const isolated = await s.service('plan', { ...s.input, values: { routing: null } }); assert.equal(isolated.status, 200, isolated.text);
  } finally { await s.f.close(); }
});

test('rehearsal keeps source mail identity read-only, forces null in approved and runner configuration, and cleanup never carries it', async () => {
  const s = await emailRoutingFixture();
  try {
    const first = await s.deploy(), original = structuredClone(s.state.request.configuration);
    const p = await s.service('plan', { action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, environment: 'test-123456789abc' });
    assert.equal(p.status, 200, p.text); const plan = p.json(); assert.equal(plan.plan.configuration.routing, null);
    assert.ok(plan.plan.operation.context.source.resources.some(r => r.kind === 'email-routing'));
    assert.ok(plan.plan.operation.context.resources.every(r => r.kind !== 'email-routing'));
    assert.equal((await s.submit(plan)).status, 200); assert.equal(s.state.request.configuration.routing, null);
    s.complete(await (await s.machine()).json()); await s.service('service-state', { instanceId: plan.taskId, reconcile: true });
    const remove = await s.service('plan', { action: 'destroy-preview', instanceId: plan.taskId, previousTaskId: plan.taskId });
    assert.equal(remove.status, 200, remove.text); assert.ok(remove.json().plan.operation.context.resources.every(r => r.kind !== 'email-routing'));
    assert.equal((await s.submit(remove.json())).status, 200); assert.equal(s.state.request.configuration.routing, null);
    assert.equal(s.live.rule.actions[0].value[0], 'test-worker');
    assert.deepEqual((await s.service('service-state', { instanceId: first.taskId, reconcile: true })).json().configuration, original);
    assert.ok(s.live.writes.every(r => r.method === 'POST' && r.path.endsWith('/d1/database')));
  } finally { await s.f.close(); }
});

test('different Workers cannot acquire the same zone identity even when the provider is neutral again', async () => {
  const s = await emailRoutingFixture();
  try {
    await s.deploy(); s.live.rule.enabled = false; s.live.rule.actions = [{ type: 'drop' }];
    const response = await s.service('plan', { ...s.input, environment: 'different' }); assert.equal(response.status, 200, response.text);
    assert.equal((await s.submit(response.json())).status, 409);
    assert.equal(s.state.created.length, 1); assert.equal(s.state.dispatches, 1);
    assert.ok(s.live.writes.every(r => r.method === 'POST' && r.path.endsWith('/d1/database')));
  } finally { await s.f.close(); }
});

test('ordinary mail deletion unbinds first, verifies absence, preserves shared Zone/MX, and does not replay', async () => {
  const s = await emailRoutingFixture();
  try {
    const first = await s.deploy(), live = deletionProvider(s);
    const response = await s.service('delete-plan', { instanceId: first.taskId, previousTaskId: first.taskId });
    assert.equal(response.status, 200, response.text); const review = { ...response.json(), acceptUnverifiedReferences: false };
    const route = review.plan.resources.find(r => r.kind === 'email-routing'); assert.equal(route.worker, 'test-worker'); assert.equal(route.present, true);
    const result = await s.service('delete-submit', review); assert.equal(result.status, 200, result.text); assert.equal(result.json().status, 'deleted', result.text);
    assert.equal(s.live.rule.enabled, false); assert.deepEqual(s.live.rule.actions, [{ type: 'drop' }]);
    assert.deepEqual(s.live.writes.filter(r => r.method === 'PUT'), [{ method: 'PUT', path: s.routePath }]);
    assert.equal(live.deletes.length, 3); await s.f.restart();
    assert.equal((await s.service('delete-submit', review)).json().status, 'deleted'); assert.equal(s.live.writes.filter(r => r.method === 'PUT').length, 1);
  } finally { await s.f.close(); }
});

test('mail deletion rejects drift and undeclared account-wide Worker references before writes; lost unbind is durable unknown', async () => {
  const s = await emailRoutingFixture();
  try {
    const first = await s.deploy(), live = deletionProvider(s), body = { instanceId: first.taskId, previousTaskId: first.taskId };
    s.live.extraRules = [{ ...s.live.rule, id: '1'.repeat(32), zone: { tag: '2'.repeat(32), name: 'other.invalid' } }];
    assert.equal((await s.service('delete-plan', body)).status, 409); s.live.extraRules = [];
    const response = await s.service('delete-plan', body); assert.equal(response.status, 200, response.text);
    const review = { ...response.json(), acceptUnverifiedReferences: false };
    s.live.rule.name = 'Changed outside'; assert.equal((await s.service('delete-submit', review)).status, 409); s.live.rule.name = 'Original rule';
    s.live.lost = true;
    const result = await s.service('delete-submit', review); assert.equal(result.json().status, 'delete-unknown', result.text);
    assert.equal(result.json().resources.find(r => r.kind === 'email-routing').status, 'unknown');
    assert.deepEqual(live.deletes, []); assert.equal(live.worker, true); assert.equal(live.database, true);
    await s.f.restart(); assert.equal((await s.service('delete-submit', review)).json().status, 'delete-unknown');
    assert.equal(s.live.writes.filter(r => r.method === 'PUT').length, 1);
  } finally { await s.f.close(); }
});
