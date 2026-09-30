import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openCoordinator } from '../src/execution/coordinator.mjs';
import { atomicWrite } from '../src/execution/journal.mjs';
import { digest, releaseSpec } from '../src/execution/plan.mjs';
import { fixture, input, human, ai, row, deploy, approve, image, objectId } from './helpers/execution.mjs';

test('four services complete bound test, approval, v1/v2 deployment and known-good rollback', async t => {
  const f = fixture(t), c = f.coordinator;
  for (const service of ['gateway', 'forum', 'game', 'account']) {
    await deploy(c, `${service}-test1`, 'test', service); await approve(c, `${service}-approve1`, service);
    await deploy(c, `${service}-promote1`, 'promote', service);
    const next = f.data.releases.find(r => r.service === service && r.artifact === image(2));
    const spec = releaseSpec(next); f.backend.stage(next);
    await c.submit(input(`${service}-candidate2`, 'candidate', { artifact: spec.artifact, configDigest: spec.configDigest }, service), human);
    await deploy(c, `${service}-test2`, 'test', service); await approve(c, `${service}-approve2`, service);
    await deploy(c, `${service}-promote2`, 'promote', service);
    f.backend.stage(f.data.releases.find(r => r.service === service && r.artifact === image(1)));
    await deploy(c, `${service}-rollback`, 'rollback', service);
    assert.equal(row(c, service).active.artifact, image(1));
  }
  assert.equal(f.backend.executeCount, 20);
  const before = c.snapshot(); assert.deepEqual(f.restart().snapshot(), before);
});
test('request IDs deduplicate completed and pending operations and bind actor and exact input', async t => {
  const f = fixture(t), c = f.coordinator, request = input('first', 'test');
  assert.equal((await c.submit(request, ai)).status, 'accepted');
  assert.equal((await c.submit(request, ai)).status, 'accepted');
  await assert.rejects(c.submit({ ...request, service: 'forum' }, ai), /reused/);
  await assert.rejects(c.submit(request, human), /reused/);
  await c.reconcile('first'); assert.equal((await c.submit(request, ai)).status, 'succeeded');
  assert.equal(f.backend.executeCount, 1);
});
test('concurrent submit and reconcile are rejected without a second execute', async t => {
  const f = fixture(t), c = f.coordinator; let release;
  f.backend.hook = path => path === 'execute/Deploy' ? new Promise(resolve => { release = () => resolve(undefined); }) : undefined;
  const pending = c.submit(input('first', 'test'), ai);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(c.submit(input('second', 'test'), ai), /busy/);
  await assert.rejects(c.reconcile('first'), /busy/); assert.throws(() => c.close(), /active/);
  release(); await pending; assert.equal(f.backend.executeCount, 1);
});
test('intent is on disk before send; accepted-but-lost response remains unknown across restart', async t => {
  const f = fixture(t); let sends = 0;
  f.backend.hook = path => {
    if (path !== 'execute/Deploy') return;
    sends++;
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'ledger.json'))).events.at(-1).kind, 'intent');
    throw new Error('response lost after remote acceptance; secret response must not escape');
  };
  const request = input('uncertain', 'test');
  assert.equal((await f.coordinator.submit(request, ai)).status, 'unknown');
  f.restart(); assert.equal((await f.coordinator.submit(request, ai)).status, 'unknown');
  await assert.rejects(f.coordinator.reconcile(request.id), /automatic resubmission is forbidden/);
  await assert.rejects(f.coordinator.submit(input('different-id', 'test'), ai), /not allowed/);
  assert.equal(sends, 1); assert.doesNotMatch(readFileSync(join(f.directory, 'ledger.json'), 'utf8'), /secret response/);
});
test('submission timeout aborts but even a late reply cannot trigger retry or claim success', async t => {
  const f = fixture(t, { timeoutMs: 20 }); let signal, finish;
  f.backend.hook = (path, _params, options) => {
    if (path === 'execute/Deploy') { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }
  };
  assert.equal((await f.coordinator.submit(input('timeout', 'test'), ai)).status, 'unknown');
  assert.equal(signal.aborted, true);
  finish({ _id: { $oid: objectId(500) }, operation: 'Deploy', target: { type: 'Deployment', id: objectId(1) }, status: 'Complete', success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.coordinator.snapshot().requests[0].status, 'unknown');
  assert.equal((await f.coordinator.submit(input('timeout', 'test'), ai)).status, 'unknown');
  assert.equal(f.backend.calls.filter(c => c.path === 'execute/Deploy').length, 1);
});
test('known ID survives restart and reconciliation only reads that update and fixed resource', async t => {
  const f = fixture(t); await f.coordinator.submit(input('known', 'test'), ai);
  f.restart(); f.backend.calls.length = 0;
  assert.equal((await f.coordinator.reconcile('known')).status, 'succeeded');
  assert.deepEqual(f.backend.calls.map(c => c.path), ['read/GetUpdate', 'read/GetDeployment', 'read/InspectDeploymentContainer']);
  assert.equal(row(f.coordinator).phase, 'tested'); assert.equal(f.backend.executeCount, 1);
});
test('restart revokes unconsumed approvals but preserves consumed approval and in-flight production', async t => {
  const f = fixture(t);
  await deploy(f.coordinator, 'test-gateway', 'test'); await approve(f.coordinator, 'approve-gateway');
  await deploy(f.coordinator, 'test-forum', 'test', 'forum'); await approve(f.coordinator, 'approve-forum', 'forum');
  await f.coordinator.submit(input('promote-forum', 'promote', {}, 'forum'), ai);
  f.restart();
  assert.equal(row(f.coordinator).phase, 'tested'); assert.equal(row(f.coordinator, 'forum').phase, 'promoting');
  await assert.rejects(f.coordinator.submit(input('promote-gateway', 'promote'), ai));
  assert.equal((await f.coordinator.submit(input('approve-gateway', 'approve', { binding: f.coordinator.snapshot().bindings.gateway }), human)).status, 'revoked');
  await f.coordinator.reconcile('promote-forum'); assert.equal(row(f.coordinator, 'forum').phase, 'live');
  const before = f.coordinator.snapshot(); assert.deepEqual(f.restart().snapshot(), before);
  await approve(f.coordinator, 'fresh-approval'); await deploy(f.coordinator, 'fresh-promote', 'promote');
});
test('full configuration, target identity and image drift fail before intent or execute', async t => {
  const f = fixture(t), c = f.coordinator, original = structuredClone(f.backend.resources.get(objectId(1)));
  for (const alter of [r => { r.config.command = 'unexpected'; }, r => { r.config.new_sensitive_default = true; },
    r => { r.name = 'different'; }, r => { r._id.$oid = objectId(999); }, r => { r.config.image.params.image = image(2); }]) {
    const changed = structuredClone(original); alter(changed); f.backend.resources.set(objectId(1), changed);
    await assert.rejects(c.submit(input('drift', 'test'), ai), /drift/);
    assert.equal(c.snapshot().history.length, 0);
  }
  assert.equal(f.backend.executeCount, 0);
  f.backend.resources.set(objectId(1), { ...original, config: Object.fromEntries(Object.entries(original.config).reverse()) });
  await deploy(c, 'drift', 'test'); assert.equal(row(c).phase, 'tested');
});
test('wrong initial receipts stay unknown and never accept arbitrary follow-up update IDs', async t => {
  const f = fixture(t);
  f.backend.hook = path => path === 'execute/Deploy' ? { _id: { $oid: objectId(501) }, operation: 'Deploy', target: { type: 'Deployment', id: objectId(9) }, status: 'Queued', success: false } : undefined;
  assert.equal((await f.coordinator.submit(input('bad-receipt', 'test'), ai)).status, 'unknown');
  await assert.rejects(f.coordinator.reconcile(objectId(501)), /unknown execution request/);
});
test('final status, update ID, operation and target must match; unhealthy success stays unresolved', async t => {
  const f = fixture(t), c = f.coordinator;
  const request = await c.submit(input('verify', 'test'), ai), original = f.backend.updates.get(request.updateId);
  for (const delta of [{ _id: { $oid: objectId(999) } }, { operation: 'RunProcedure' }, { target: { type: 'Deployment', id: objectId(9) } },
    { target: { type: 'Procedure', id: objectId(1) } }, { status: 'Unknown' }, { success: 'true' }]) {
    f.backend.updates.set(request.updateId, { ...original, ...delta }); await assert.rejects(c.reconcile('verify'), /mismatch/);
  }
  f.backend.updates.set(request.updateId, { ...original, status: 'InProgress' });
  assert.equal((await c.reconcile('verify')).status, 'accepted');
  f.backend.updates.set(request.updateId, original);
  f.backend.hook = path => path === 'read/InspectDeploymentContainer' ? { Image: image(1), State: { Running: true } } : undefined;
  await assert.rejects(c.reconcile('verify'), /not confirmed/); assert.equal(row(c).phase, 'testing');
  f.backend.hook = null; await c.reconcile('verify'); assert.equal(row(c).phase, 'tested');
});
test('confirmed failure blocks promotion; failed first production has no invented rollback', async t => {
  const f = fixture(t), c = f.coordinator;
  let request = await c.submit(input('bad-test', 'test'), ai); f.backend.updates.get(request.updateId).success = false;
  assert.equal((await c.reconcile('bad-test')).status, 'failed'); await assert.rejects(approve(c, 'bad-approval'));
  await deploy(c, 'good-test', 'test'); await approve(c, 'good-approval');
  request = await c.submit(input('bad-promote', 'promote'), ai); f.backend.updates.get(request.updateId).success = false;
  await c.reconcile('bad-promote'); await assert.rejects(c.submit(input('bad-rollback', 'rollback'), ai), /no known/);
});
test('invalid operations, runner impersonation, parameters and catalog escape never issue calls', async t => {
  const f = fixture(t), c = f.coordinator;
  for (const request of [input('x', 'shell'), input('x', 'test-result', { success: true }), input('x', 'test', { target: 'elsewhere' }),
    input('x', 'test', {}, 'other'), { ...input('x', 'test'), id: 1 }, { ...input('x', 'test'), url: 'https://example.com' }]) await assert.rejects(c.submit(request, ai));
  await assert.rejects(c.submit(input('x', 'test'), { id: 'runner', role: 'runner' }));
  await assert.rejects(c.submit(input('unknown', 'candidate', { artifact: image(3), configDigest: digest({ arbitrary: true }) }), human), /catalog/);
  assert.equal(f.backend.calls.length, 0); assert.equal(c.snapshot().history.length, 0);
});
test('write failure before intent sends nothing and poisons until inspected restart', async t => {
  const f = fixture(t); f.restart({ storage: { writeFile() { throw new Error('disk full'); } } });
  await assert.rejects(f.coordinator.submit(input('disk-fail', 'test'), ai), /write uncertain/);
  assert.throws(() => f.coordinator.snapshot(), /unavailable/); assert.equal(f.backend.executeCount, 0);
  assert.equal(f.restart().snapshot().history.length, 0);
});
test('rename succeeded but durability reported failure: restart retains unknown intent without sending', async t => {
  const f = fixture(t);
  f.restart({ storage: { writeFile(...args) { atomicWrite(...args); throw new Error('directory fsync outcome uncertain'); } } });
  await assert.rejects(f.coordinator.submit(input('committed-not-sent', 'test'), ai), /write uncertain/);
  assert.equal(f.backend.executeCount, 0); f.restart();
  assert.equal((await f.coordinator.submit(input('committed-not-sent', 'test'), ai)).status, 'unknown');
  assert.equal(f.backend.executeCount, 0);
});
test('receipt persistence failure after send prevents second send and preserves unknown state', async t => {
  const f = fixture(t); let writes = 0;
  f.restart({ storage: { writeFile(...args) { if (++writes === 2) throw new Error('receipt write failed'); atomicWrite(...args); } } });
  await assert.rejects(f.coordinator.submit(input('lost-id', 'test'), ai), /write uncertain/);
  assert.equal(f.backend.executeCount, 1); f.restart();
  assert.equal((await f.coordinator.submit(input('lost-id', 'test'), ai)).status, 'unknown'); assert.equal(f.backend.executeCount, 1);
});
test('journal lock, catalog binding and corrupt history fail closed without overwriting data', t => {
  const f = fixture(t), file = join(f.directory, 'ledger.json');
  assert.throws(() => openCoordinator({ directory: f.directory, ...f.data, transport: f.backend }), /locked/);
  f.coordinator.close(); const original = readFileSync(file, 'utf8');
  const changed = structuredClone(f.data); changed.releases[4].test.config.command = 'changed';
  assert.throws(() => openCoordinator({ directory: f.directory, ...changed, transport: f.backend }), /binding/);
  assert.equal(readFileSync(file, 'utf8'), original); assert.equal(existsSync(join(f.directory, 'owner.lock')), false);
  writeFileSync(file, '{'); assert.throws(() => openCoordinator({ directory: f.directory, ...f.data, transport: f.backend }));
  assert.equal(readFileSync(file, 'utf8'), '{');
  rmSync(file); const foreign = join(f.directory, 'foreign'); writeFileSync(foreign, 'untouched'); symlinkSync(foreign, file);
  assert.throws(() => openCoordinator({ directory: f.directory, ...f.data, transport: f.backend })); assert.equal(readFileSync(foreign, 'utf8'), 'untouched');
});

test('outcome committed before a reported disk error is recovered without redeployment', async t => {
  const f = fixture(t);
  await f.coordinator.submit(input('outcome-uncertain', 'test'), ai);
  f.restart({ storage: { writeFile(...args) { atomicWrite(...args); throw new Error('after rename'); } } });
  await assert.rejects(f.coordinator.reconcile('outcome-uncertain'), /write uncertain/);
  assert.throws(() => f.coordinator.snapshot(), /unavailable/);
  f.restart(); assert.equal(row(f.coordinator).phase, 'tested');
  assert.equal((await f.coordinator.submit(input('outcome-uncertain', 'test'), ai)).status, 'succeeded');
  assert.equal(f.backend.executeCount, 1);
});

test('failed restart approval revocation never exposes an approved coordinator', async t => {
  const f = fixture(t); await deploy(f.coordinator, 'before-restart', 'test'); await approve(f.coordinator, 'revoke-me');
  assert.throws(() => f.restart({ storage: { writeFile() { throw new Error('disk unavailable'); } } }), /write uncertain/);
  const c = f.restart(); assert.equal(row(c).phase, 'tested');
  assert.equal(c.snapshot().requests.find(r => r.input.id === 'revoke-me').status, 'revoked');
  await assert.rejects(c.submit(input('cannot-promote', 'promote'), ai));
});

test('multiple restart revocations preserve consumed approvals and reject tampered plans on replay', async t => {
  const f = fixture(t);
  for (const service of ['gateway', 'forum']) {
    await deploy(f.coordinator, `${service}-tested`, 'test', service); await approve(f.coordinator, `${service}-approval`, service);
  }
  f.restart(); await approve(f.coordinator, 'gateway-fresh'); await deploy(f.coordinator, 'gateway-live', 'promote');
  await approve(f.coordinator, 'forum-fresh', 'forum'); f.restart();
  assert.equal(row(f.coordinator).phase, 'live'); assert.equal(row(f.coordinator, 'forum').phase, 'tested');
  await approve(f.coordinator, 'forum-new', 'forum'); await deploy(f.coordinator, 'forum-live', 'promote', 'forum');
  const before = f.coordinator.snapshot(); assert.deepEqual(f.restart().snapshot(), before);
  f.coordinator.close(); const file = join(f.directory, 'ledger.json'), data = JSON.parse(readFileSync(file));
  data.events.find(e => e.kind === 'intent').plan.target = objectId(999);
  const corrupted = JSON.stringify(data); writeFileSync(file, corrupted);
  assert.throws(() => openCoordinator({ directory: f.directory, ...f.data, transport: f.backend }), /plan mismatch/);
  assert.equal(readFileSync(file, 'utf8'), corrupted);
});

test('caller mutation during a suspended preflight cannot change the persisted approval target', async t => {
  const f = fixture(t); let release;
  f.backend.hook = path => path === 'read/GetDeployment' ? new Promise(resolve => { release = () => resolve(undefined); }) : undefined;
  const request = input('immutable-input', 'test'), actor = { ...ai };
  const pending = f.coordinator.submit(request, actor);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  request.service = 'forum'; actor.id = 'changed-actor'; release();
  const accepted = await pending;
  assert.equal(accepted.input.service, 'gateway'); assert.equal(accepted.actor.id, ai.id);
  assert.equal(accepted.plan.target, objectId(1));
});
