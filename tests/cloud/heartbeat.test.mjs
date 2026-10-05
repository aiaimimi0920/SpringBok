import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { adminFixture } from './admin-fixture.mjs';
import { heartbeatFlags, heartbeatOptions, heartbeatNode, heartbeatCall, heartbeatSample, heartbeatRpc as rpc } from './heartbeat-fixture.mjs';

test('role heartbeat is default-off, owner/node/enrollment authenticated, bounded and separate from task or catalog changes', async () => {
  const disabled = await adminFixture();
  try { assert.equal((await disabled.call(`/node/v2/heartbeat/execute/${'a'.repeat(64)}/${randomUUID()}/${randomUUID()}/read`, { token: null, body: { protocolVersion: 2 } })).status, 503); } finally { await disabled.close(); }
  const f = await adminFixture(heartbeatFlags, heartbeatOptions);
  try {
    const a = await heartbeatNode(f), b = await heartbeatNode(f), other = await heartbeatNode(f, { sub: 'another-heartbeat-owner' }), pending = await heartbeatNode(f, {}, false);
    const before = await rpc(f, a.context, 'inspect'), catalog = (await f.call('/api/admin/servers', { token: a.token })).json();
    assert.equal((await f.call(pending.path, { token: pending.token })).json().roles.execute.reason, 'not-joined');
    await heartbeatCall(f, pending.roles.execute, 'read', { protocolVersion: 2 }, 409);
    for (const target of [b.roles.execute, other.roles.execute, a.roles.observe]) await heartbeatCall(f, { ...target, token: a.roles.execute.token }, 'read', { protocolVersion: 2 }, 409);
    for (const token of [a.challenge, f.bindings.NODE_TOKEN]) await heartbeatCall(f, { ...a.roles.execute, token }, 'read', { protocolVersion: 2 }, 409);
    await heartbeatCall(f, { ...a.roles.execute, enrollmentId: randomUUID() }, 'read', { protocolVersion: 2 }, 409);
    const empty = { ...a.roles.execute, nodeId: randomUUID() }; await heartbeatCall(f, empty, 'read', { protocolVersion: 2 }, 409); assert.deepEqual(await rpc(f, empty, 'inspect'), []);
    for (const body of [{ protocolVersion: 1 }, { protocolVersion: 2, role: 'execute' }, { protocolVersion: 2, token: 'no' }]) await heartbeatCall(f, a.roles.execute, 'read', body, 409);
    for (const headers of [{ cookie: 'a=1' }, { origin: 'https://other.invalid' }, { authorization: 'Bearer invalid' }]) await heartbeatCall(f, a.roles.execute, 'read', { protocolVersion: 2 }, 403, { headers });
    assert.equal((await f.call(a.path, { token: null })).status, 403); assert.equal((await f.call(a.path, { token: other.token })).status, 409);
    assert.equal((await f.call(a.path, { token: a.token, body: {} })).status, 404);
    assert.deepEqual(await rpc(f, a.context, 'inspect'), before); // read/拒绝不迁移。
    const beat = await heartbeatSample(f, a.roles.execute, 8640000000000000);
    assert.equal(beat.response.result.status, 'recorded');
    const snapshot = (await f.call(a.path, { token: a.token })).json(); assert.equal(snapshot.roles.execute.status, 'online'); assert.equal(snapshot.roles.observe.status, 'unknown'); assert.equal(snapshot.executionReady, false);
    assert.equal((await f.call(b.path, { token: b.token })).json().roles.execute.status, 'unknown');
    assert.deepEqual((await f.call('/api/admin/servers', { token: a.token })).json(), catalog);
    const after = await rpc(f, a.context, 'inspect');
    for (const name of ['node_enrollment', 'node_ledger']) assert.deepEqual(after.find(r => r.name === name), before.find(r => r.name === name));
    assert.equal(after.find(r => r.name === 'node_meta').rows[0].schema_version, 3); assert.equal(after.find(r => r.name === 'node_heartbeat').rows.length, 1);
    for (const secret of [a.roles.execute.token, a.roles.observe.token, a.challenge]) assert.equal(JSON.stringify(after).includes(secret), false);
    await rpc(f, a.context, 'schema2Identity', [a.context, 'execute', a.roles.execute.token], 409); assert.deepEqual(await rpc(f, a.context, 'inspect'), after); // 回退读者失败关闭。
    assert.equal((await f.call('/api/admin/state', { token: a.token })).json().jobs.length, 0);
  } finally { await f.close(); }
});
test('workerd persists independent roles, exact sample replay, reboot CAS and cloud-time stale/offline thresholds across restart', async () => {
  const f = await adminFixture({ ...heartbeatFlags, ENROLLMENT_FAULT: 'catalog-finalize-before' }, heartbeatOptions);
  try {
    const n = await heartbeatNode(f), execute = await heartbeatSample(f, n.roles.execute, 0), observe = await heartbeatSample(f, n.roles.observe, 8640000000000000);
    assert.equal((await f.call('/api/admin/servers', { token: n.token })).json().servers[0].state, 'enrolling');
    assert.equal((await f.call(n.path, { token: n.token })).json().roles.observe.status, 'online');
    const before = await rpc(f, n.context, 'inspect'); await f.restart(); assert.deepEqual(await rpc(f, n.context, 'inspect'), before);
    assert.deepEqual(await heartbeatCall(f, n.roles.execute, 'sample', execute.input), execute.response);
    const early = await heartbeatCall(f, n.roles.execute, 'sample', { ...execute.input, sequence: 2 }); assert.equal(early.result.status, 'deferred'); assert.deepEqual(await rpc(f, n.context, 'inspect'), before);
    await heartbeatCall(f, n.roles.execute, 'sample', { ...execute.input, sequence: 1, sampledAt: 1 }, 409);
    const bootId = randomUUID(), started = await heartbeatCall(f, n.roles.execute, 'start', { protocolVersion: 2, bootId, previousGeneration: 1 }); assert.equal(started.result.generation, 2);
    const rebootEarly = await heartbeatCall(f, n.roles.execute, 'sample', { ...execute.input, bootId, generation: 2 }); assert.equal(rebootEarly.result.status, 'deferred');
    assert.equal((await f.call(n.path, { token: n.token })).json().roles.execute.sample.bootId, execute.input.bootId);
    await heartbeatCall(f, n.roles.execute, 'start', { protocolVersion: 2, bootId: execute.input.bootId, previousGeneration: 0 }, 409);
    await heartbeatCall(f, n.roles.execute, 'sample', execute.input, 409);
    await rpc(f, n.context, 'damage', ['heartbeat-age', 'execute', 90000]);
    let snapshot = (await f.call(n.path, { token: n.token })).json(); assert.equal(snapshot.roles.execute.status, 'stale'); assert.equal(snapshot.roles.observe.status, 'online');
    await rpc(f, n.context, 'damage', ['heartbeat-age', 'execute', 300000]);
    snapshot = (await f.call(n.path, { token: n.token })).json(); assert.equal(snapshot.roles.execute.status, 'offline'); assert.equal(snapshot.roles.observe.sample.bootId, observe.input.bootId);
    const recorded = await heartbeatCall(f, n.roles.execute, 'sample', { ...execute.input, bootId, generation: 2, sequence: 2 }); assert.equal(recorded.result.status, 'recorded');
    await heartbeatCall(f, n.roles.execute, 'sample', { ...execute.input, bootId, generation: 2, sequence: 1 }, 409);
    assert.equal((await f.call(n.path, { token: n.token })).json().roles.execute.status, 'online');
  } finally { await f.close(); }
});
test('heartbeat disable/restore preserves storage and joined auth does not depend on enrollment/catalog enable or task queue readiness', async () => {
  const f = await adminFixture(heartbeatFlags, heartbeatOptions);
  try {
    const n = await heartbeatNode(f); await heartbeatSample(f, n.roles.observe); const before = await rpc(f, n.context, 'inspect');
    Object.assign(f.bindings, { ENABLE_NODE_HEARTBEAT: 'no' }); await f.restart();
    await heartbeatCall(f, n.roles.observe, 'read', { protocolVersion: 2 }, 503); assert.equal((await f.call(n.path, { token: n.token })).status, 503); assert.deepEqual(await rpc(f, n.context, 'inspect'), before);
    Object.assign(f.bindings, { ENABLE_NODE_HEARTBEAT: 'yes', ENABLE_NODE_ENROLLMENT: 'no', ENABLE_NODE_CHANNEL: 'no', ENABLE_CATALOG: 'no' }); await f.restart();
    await heartbeatCall(f, n.roles.observe, 'read', { protocolVersion: 2 }); assert.deepEqual(await rpc(f, n.context, 'inspect'), before);
    Object.assign(f.bindings, { ENABLE_CATALOG: 'yes' }); await f.restart(); assert.equal((await f.call(n.path, { token: n.token })).json().roles.observe.status, 'online');
    f.bindings.ENABLE_NODE_CREDENTIALS = 'no'; await f.restart(); await heartbeatCall(f, n.roles.observe, 'read', { protocolVersion: 2 }, 503); assert.deepEqual(await rpc(f, n.context, 'inspect'), before);
  } finally { await f.close(); }
});
test('damaged heartbeat reads fail closed without rebuilding or blocking intact identity and task receipts; unknown core schema still rejects', async () => {
  const f = await adminFixture(heartbeatFlags, heartbeatOptions);
  try {
    for (const kind of ['heartbeat-table', 'heartbeat-record', 'version']) {
      const n = await heartbeatNode(f); await heartbeatSample(f, n.roles.execute);
      const probePath = n.path.replace('/heartbeat', '/probe'), channelPath = `/node/v2/channel/execute/${n.context.ownerId}/${n.context.nodeId}/${n.roles.execute.enrollmentId}`;
      let delivery;
      if (kind !== 'version') {
        const submitted = await f.call(probePath, { token: n.token, headers: n.headers, body: { requestId: randomUUID(), revision: 0, challenge: randomBytes(32).toString('hex') } }); assert.equal(submitted.status, 200);
        const claimed = await f.call(channelPath + '/poll', { token: null, headers: { authorization: `Bearer ${n.roles.execute.token}` }, body: { protocolVersion: 2 } }); assert.equal(claimed.status, 200); delivery = claimed.json().result.input;
      }
      await rpc(f, n.context, 'damage', [kind]); const before = await rpc(f, n.context, 'inspect'); await f.restart();
      await heartbeatCall(f, n.roles.execute, 'read', { protocolVersion: 2 }, 409); assert.equal((await f.call(n.path, { token: n.token })).status, 409);
      assert.deepEqual(await rpc(f, n.context, 'inspect'), before);
      if (kind !== 'version') {
        const identity = await f.call(`/node/v2/identity/execute/${n.context.ownerId}/${n.context.nodeId}`, { token: null, headers: { authorization: `Bearer ${n.roles.execute.token}` }, body: { protocolVersion: 2 } }); assert.equal(identity.status, 200);
        const report = await f.call(channelPath + '/report', { token: null, headers: { authorization: `Bearer ${n.roles.execute.token}` }, body: { protocolVersion: 2, requestId: delivery.requestId, planDigest: delivery.planDigest, challenge: delivery.challenge, outcome: 'observed' } }); assert.equal(report.status, 200); assert.equal(report.json().result.status, 'observed');
        assert.equal((await f.call(probePath, { token: n.token })).json().jobs[0].status, 'observed');
        const after = await rpc(f, n.context, 'inspect'); assert.deepEqual(after.find(r => r.name === 'node_heartbeat'), before.find(r => r.name === 'node_heartbeat')); assert.deepEqual(after.find(r => r.name === 'node_enrollment'), before.find(r => r.name === 'node_enrollment'));
      }
    }
  } finally { await f.close(); }
});
