import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { adminFixture, origin } from './admin-fixture.mjs';
import { heartbeatRpc as nodeRpc, heartbeatSample, heartbeatCall } from './heartbeat-fixture.mjs';
import { telemetryFlags, telemetryOptions, telemetryNode, telemetryCall as call, telemetrySample, telemetryRpc as rpc, cpu, memory } from './telemetry-helper.mjs';
import { telemetryAuthorization } from '../../cloud/telemetry-contract.mjs';

test('CPU telemetry is default-off, joined observe-only, owner/node/enrollment bound and never stores credentials or changes task/catalog/heartbeat', async () => {
  const disabled = await adminFixture({}, telemetryOptions);
  try { assert.equal((await disabled.call(`/node/v2/telemetry/observe/${'a'.repeat(64)}/${randomUUID()}/${randomUUID()}/read`, { token: null, body: { protocolVersion: 2 } })).status, 503); } finally { await disabled.close(); }
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    const a = await telemetryNode(f), b = await telemetryNode(f), other = await telemetryNode(f, { sub: 'another-telemetry-owner' }), pending = await telemetryNode(f, {}, false), c = a.roles.observe;
    const before = await nodeRpc(f, a.context, 'inspect'), catalog = (await f.call('/api/admin/servers', { token: a.token })).json();
    assert.equal((await f.call(pending.path, { token: pending.token })).json().reason, 'not-joined');
    await call(f, pending.roles.observe, 'read', { protocolVersion: 2 }, 409); await call(f, a.roles.execute, 'read', { protocolVersion: 2 }, 404);
    for (const target of [b.roles.observe, other.roles.observe, { ...c, enrollmentId: randomUUID() }]) await call(f, { ...target, token: c.token }, 'read', { protocolVersion: 2 }, 409);
    for (const token of [a.roles.execute.token, a.challenge, f.bindings.NODE_TOKEN]) await call(f, { ...c, token }, 'read', { protocolVersion: 2 }, 409);
    for (const headers of [{ cookie: 'a=1' }, { origin: 'https://other.invalid' }, { authorization: 'Bearer invalid' }]) await call(f, c, 'read', { protocolVersion: 2 }, 403, { headers });
    await call(f, c, 'read', { protocolVersion: 2, ownerId: c.ownerId }, 409);
    await call(f, c, 'read', { protocolVersion: 2 }); assert.deepEqual(await rpc(f, a.telemetryContext, 'inspect'), []);
    assert.equal((await f.call(a.path, { token: null })).status, 403); assert.equal((await f.call(a.path, { token: other.token })).status, 409);
    assert.equal((await f.call(a.path, { token: a.token, body: {} })).status, 404); assert.equal((await f.call(a.path + '?ownerId=other', { token: a.token })).status, 403);
    await telemetrySample(f, c, cpu(), memory()); const snapshot = (await f.call(a.path, { token: a.token })).json(); assert.equal(snapshot.sample.cpu.usagePercent, 0); assert.equal(snapshot.sample.sampleVersion, 2); assert.deepEqual(snapshot.sample.memory, memory()); assert.equal(snapshot.freshness, 'fresh'); assert.equal(snapshot.executionReady, false);
    assert.equal((await f.call(b.path, { token: b.token })).json().sample, null);
    assert.deepEqual(await nodeRpc(f, a.context, 'inspect'), before); assert.deepEqual((await f.call('/api/admin/servers', { token: a.token })).json(), catalog);
    const tables = await rpc(f, a.telemetryContext, 'inspect'); assert.equal(tables.length, 2); assert.equal(tables.find(t => t.name === 'telemetry_state').rows.length, 1);
    for (const secret of [c.token, a.roles.execute.token, a.challenge]) assert.equal(JSON.stringify(tables).includes(secret), false);
    await rpc(f, b.telemetryContext, 'rawApply', [telemetryAuthorization(a.context, c.enrollmentId), 'read', { protocolVersion: 2 }], 409); assert.deepEqual(await rpc(f, b.telemetryContext, 'inspect'), []);
  } finally { await f.close(); }
});
test('real SQLite telemetry restart, full replay, stale receipt refusal, CAS competition and cross-boot rate preserve latest', async () => {
  const f = await adminFixture({ ...telemetryFlags, ENROLLMENT_FAULT: 'catalog-finalize-before' }, telemetryOptions);
  try {
    const n = await telemetryNode(f), c = n.roles.observe, first = await telemetrySample(f, c);
    assert.equal((await f.call('/api/admin/servers', { token: n.token })).json().servers[0].state, 'enrolling');
    const before = await rpc(f, n.telemetryContext, 'inspect'); await f.restart(); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), before);
    assert.deepEqual(await call(f, c, 'sample', first.input), first.response);
    await call(f, c, 'sample', { ...first.input, cpu: cpu(1) }, 409);
    assert.equal((await call(f, c, 'sample', { ...first.input, sequence: 2 })).result.status, 'deferred');
    const bootId = randomUUID(), requests = [bootId, randomUUID()].map(id => f.call(`/node/v2/telemetry/observe/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/start`, { token: null, headers: { authorization: `Bearer ${c.token}` }, body: { protocolVersion: 2, bootId: id, previousGeneration: 1 } }));
    const results = await Promise.all(requests); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const activeBoot = results.find(r => r.status === 200).json().result.bootId;
    const next = { ...first.input, bootId: activeBoot, generation: 2, sequence: 1 };
    assert.equal((await call(f, c, 'sample', next)).result.status, 'deferred');
    await call(f, c, 'sample', { ...first.input, sequence: 999999 }, 409);
    await rpc(f, n.telemetryContext, 'damage', ['age', 90000]); assert.equal((await f.call(n.path, { token: n.token })).json().freshness, 'stale');
    const second = await call(f, c, 'sample', next); assert.equal(second.result.status, 'recorded');
    assert.deepEqual(await call(f, c, 'sample', next), second);
    await call(f, c, 'sample', first.input, 409);
    assert.equal((await rpc(f, n.telemetryContext, 'inspect')).find(t => t.name === 'telemetry_state').rows.length, 1);
  } finally { await f.close(); }
});
test('telemetry body reader enforces actual 8 KiB/UTF-8/declared limits while old heartbeat still rejects more than 2 KiB', async () => {
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    const n = await telemetryNode(f), c = n.roles.observe, path = `/node/v2/telemetry/observe/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/read`, headers = { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' };
    const input = JSON.stringify({ protocolVersion: 2 }), padded = size => input + ' '.repeat(size - input.length);
    const stream = text => { const bytes = new TextEncoder().encode(text); let i = 0; return new ReadableStream({ pull(controller) { if (i === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(i, i + 1024)); i = Math.min(bytes.length, i + 1024); } } }); };
    for (const [size, status] of [[8192, 200], [8193, 409]]) assert.equal((await f.mf.dispatchFetch(origin + path, { method: 'POST', headers, body: stream(padded(size)), duplex: 'half' })).status, status);
    for (const contentLength of ['8193', 'invalid']) assert.equal((await f.call('/__telemetry_http', { body: { path, headers: { ...headers, 'content-length': contentLength }, body: input } })).status, 409);
    assert.equal((await f.mf.dispatchFetch(origin + path, { method: 'POST', headers, body: new Uint8Array([0xff, 0xfe]) })).status, 409);
    const heartbeat = path.replace('/telemetry/', '/heartbeat/'); assert.equal((await f.mf.dispatchFetch(origin + heartbeat, { method: 'POST', headers, body: padded(2049) })).status, 409);
    assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), []);
  } finally { await f.close(); }
});
test('telemetry write-before failure has no receipt, write-after lost ack replays original durable sample, disable/restore keeps all data', async () => {
  for (const fault of ['before', 'after']) {
    const f = await adminFixture({ ...telemetryFlags, TELEMETRY_FAULT: fault }, telemetryOptions);
    try {
      const n = await telemetryNode(f), c = n.roles.observe;
      const started = await call(f, c, 'start', { protocolVersion: 2, bootId: randomUUID(), previousGeneration: 0 });
      const input = { protocolVersion: 2, bootId: started.result.bootId, generation: 1, sequence: 1, cpu: cpu(), sampleVersion: 2, memory: memory() };
      await call(f, c, 'sample', input, 409);
      const state = JSON.parse((await rpc(f, n.telemetryContext, 'inspect')).find(t => t.name === 'telemetry_state').rows[0].state);
      assert.equal(state.latest === null, fault === 'before');
      assert.equal((await rpc(f, n.telemetryContext, 'inspect')).find(t => t.name === 'telemetry_meta').rows[0].schema_version, fault === 'before' ? 1 : 2);
      const retry = await call(f, c, 'sample', input); assert.equal(retry.result.status, 'recorded');
      if (fault === 'after') assert.deepEqual(retry.result.sample, state.latest);
      const before = await rpc(f, n.telemetryContext, 'inspect'); f.bindings.ENABLE_NODE_TELEMETRY = 'no'; await f.restart();
      await call(f, c, 'read', { protocolVersion: 2 }, 503); assert.equal((await f.call(n.path, { token: n.token })).status, 503); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), before);
      Object.assign(f.bindings, { ENABLE_NODE_TELEMETRY: 'yes', ENABLE_NODE_ENROLLMENT: 'no', ENABLE_NODE_CHANNEL: 'no', ENABLE_CATALOG: 'no', ENABLE_NODE_HEARTBEAT: 'no' }); await f.restart();
      await call(f, c, 'read', { protocolVersion: 2 }); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), before);
      Object.assign(f.bindings, { ENABLE_CATALOG: 'yes', ENABLE_NODE_CREDENTIALS: 'no' }); await f.restart(); await call(f, c, 'read', { protocolVersion: 2 }, 503); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), before);
    } finally { await f.close(); }
  }
});
test('SQLite memory expansion upgrades only recorded writes atomically, survives restart and never downgrades mixed latest', async () => {
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    const n = await telemetryNode(f), c = n.roles.observe, first = await telemetrySample(f, c);
    const meta = async () => (await rpc(f, n.telemetryContext, 'inspect')).find(t => t.name === 'telemetry_meta').rows[0];
    const next = { ...first.input, sequence: 2, sampleVersion: 2, memory: memory(1) };
    const unchanged = await rpc(f, n.telemetryContext, 'inspect');
    for (const malformed of [{ ...next, sequence: 1 }, { ...next, sampleVersion: 3 }, { ...first.input, memory: memory() }, { ...next, memory: { ...memory(), availableBytes: -1 } }]) await call(f, c, 'sample', malformed, 409);
    assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), unchanged);
    assert.equal((await call(f, c, 'sample', next)).result.status, 'deferred'); assert.equal((await meta()).schema_version, 1);
    await rpc(f, n.telemetryContext, 'damage', ['age', 90000]);
    await rpc(f, n.telemetryContext, 'damage', ['upgrade-write']); const original = await rpc(f, n.telemetryContext, 'inspect');
    await call(f, c, 'sample', next, 409); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), original);
    await rpc(f, n.telemetryContext, 'damage', ['remove-upgrade-write']);
    const recorded = await call(f, c, 'sample', next); assert.equal(recorded.result.status, 'recorded'); assert.equal((await meta()).schema_version, 2);
    await call(f, c, 'sample', { ...next, memory: memory(2) }, 409); await call(f, c, 'sample', { ...first.input, sequence: 2 }, 409);
    const expanded = await rpc(f, n.telemetryContext, 'inspect'); await f.restart(); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), expanded); assert.deepEqual(await call(f, c, 'sample', next), recorded);
    f.bindings.TELEMETRY_READER = 'legacy'; await f.restart();
    await call(f, c, 'read', { protocolVersion: 2 }, 409); await call(f, c, 'start', { protocolVersion: 2, bootId: randomUUID(), previousGeneration: 1 }, 409); await call(f, c, 'sample', first.input, 409);
    assert.equal((await f.call(n.path, { token: n.token })).status, 409); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), expanded);
    f.bindings.TELEMETRY_READER = 'current'; await f.restart(); assert.deepEqual((await f.call(n.path, { token: n.token })).json().sample, recorded.result.sample);
    await rpc(f, n.telemetryContext, 'damage', ['age', 90000]);
    assert.equal((await call(f, c, 'sample', { ...first.input, sequence: 3 })).result.status, 'recorded'); assert.equal((await meta()).schema_version, 2);
    const oldLatest = (await f.call(n.path, { token: n.token })).json().sample; assert.equal(Object.hasOwn(oldLatest, 'memory'), false); assert.equal(Object.keys(oldLatest).length, 5);
    await f.restart(); assert.equal((await meta()).schema_version, 2);
  } finally { await f.close(); }
});
test('schema one with versioned latest is corruption, not an automatic repair or migration', async () => {
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    const n = await telemetryNode(f); await telemetrySample(f, n.roles.observe, cpu(), memory()); await rpc(f, n.telemetryContext, 'damage', ['schema-one']);
    const before = await rpc(f, n.telemetryContext, 'inspect'); await f.restart(); await call(f, n.roles.observe, 'read', { protocolVersion: 2 }, 409);
    assert.equal((await f.call(n.path, { token: n.token })).status, 409); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), before);
  } finally { await f.close(); }
});
async function probe(f, n) {
  const path = n.path.replace('/telemetry', '/probe'), c = n.roles.execute;
  const submitted = await f.call(path, { token: n.token, headers: n.headers, body: { requestId: randomUUID(), revision: 0, challenge: randomBytes(32).toString('hex') } }); assert.equal(submitted.status, 200);
  const channel = `/node/v2/channel/execute/${c.ownerId}/${c.nodeId}/${c.enrollmentId}`, headers = { authorization: `Bearer ${c.token}` };
  const poll = await f.call(channel + '/poll', { token: null, headers, body: { protocolVersion: 2 } }); assert.equal(poll.status, 200); const input = poll.json().result.input;
  const report = await f.call(channel + '/report', { token: null, headers, body: { protocolVersion: 2, requestId: input.requestId, planDigest: input.planDigest, challenge: input.challenge, outcome: 'observed' } }); assert.equal(report.status, 200); assert.equal(report.json().result.status, 'observed');
}
test('telemetry persistence corruption fails closed without repair and intact execute identity/poll/report/heartbeat remain usable', async () => {
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    for (const kind of ['table', 'meta', 'record', 'version', 'owner']) {
      const n = await telemetryNode(f); await telemetrySample(f, n.roles.observe); await heartbeatSample(f, n.roles.execute);
      await rpc(f, n.telemetryContext, 'damage', [kind]); const before = await rpc(f, n.telemetryContext, 'inspect'); await f.restart();
      await call(f, n.roles.observe, 'read', { protocolVersion: 2 }, 409); assert.equal((await f.call(n.path, { token: n.token })).status, 409);
      const identity = await f.call(`/node/v2/identity/execute/${n.context.ownerId}/${n.context.nodeId}`, { token: null, headers: { authorization: `Bearer ${n.roles.execute.token}` }, body: { protocolVersion: 2 } }); assert.equal(identity.status, 200);
      await heartbeatCall(f, n.roles.execute, 'read', { protocolVersion: 2 }); await probe(f, n);
      assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), before);
    }
  } finally { await f.close(); }
});
test('a hanging cross-DO telemetry RPC never holds NodeMailbox execution serialization', async () => {
  const f = await adminFixture({ ...telemetryFlags, TELEMETRY_FAULT: 'hold' }, telemetryOptions); let pending, n;
  try {
    n = await telemetryNode(f); const c = n.roles.observe, bootId = randomUUID(); await call(f, c, 'start', { protocolVersion: 2, bootId, previousGeneration: 0 });
    pending = call(f, c, 'sample', { protocolVersion: 2, bootId, generation: 1, sequence: 1, cpu: cpu() });
    const end = Date.now() + 5000; while (!(await rpc(f, n.telemetryContext, 'waiting')) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(await rpc(f, n.telemetryContext, 'waiting'), true);
    await Promise.race([probe(f, n), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('task blocked behind telemetry RPC')), 3000); timer.unref(); })]);
    assert.equal(await rpc(f, n.telemetryContext, 'waiting'), true);
    await rpc(f, n.telemetryContext, 'release'); assert.equal((await pending).result.status, 'recorded'); pending = null;
  } finally { if (pending && n) { await rpc(f, n.telemetryContext, 'release'); await pending.catch(() => {}); } await f.close(); }
});
