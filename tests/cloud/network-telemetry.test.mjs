import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminFixture } from './admin-fixture.mjs';
import { telemetryFlags, telemetryOptions, telemetryNode, telemetrySample, telemetryCall as call, telemetryRpc as rpc, cpu, memory, disk, network } from './telemetry-helper.mjs';

test('network meta1/2/3 to4 expansion is recorded-only atomic, fixed v6 reader refuses new schema without losing data, old clients remain usable', async () => {
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    assert.equal((await f.call('/network-contract.mjs', { token: null })).status, 403); assert.equal((await f.call('/network-contract.mjs')).status, 200);
    for (const version of [1, 2, 3]) {
      const n = await telemetryNode(f), c = n.roles.observe, first = await telemetrySample(f, c, cpu(), version >= 2 ? memory() : undefined, version >= 3 ? disk() : undefined);
      const meta = async () => (await rpc(f, n.telemetryContext, 'inspect')).find(t => t.name === 'telemetry_meta').rows[0].schema_version;
      assert.equal(await meta(), version);
      f.bindings.TELEMETRY_READER = 'disk'; await f.restart(); assert.equal((await f.call(n.path, { token: n.token })).status, 200); await call(f, c, 'read', { protocolVersion: 2 });
      f.bindings.TELEMETRY_READER = 'current'; await f.restart();
      const next = { ...first.input, sampleVersion: 4, sequence: 2, memory: memory(), disk: disk(), network: network() }, original = await rpc(f, n.telemetryContext, 'inspect');
      for (const bad of [{ ...next, network: undefined }, { ...next, sampleVersion: 3 }, { ...next, network: { ...network(), private: true } }]) await call(f, c, 'sample', bad, 409);
      assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), original); assert.equal((await call(f, c, 'sample', next)).result.status, 'deferred'); assert.equal(await meta(), version);
      await rpc(f, n.telemetryContext, 'damage', ['age', 90000]); await rpc(f, n.telemetryContext, 'damage', ['upgrade-write']); const interrupted = await rpc(f, n.telemetryContext, 'inspect');
      await call(f, c, 'sample', next, 409); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), interrupted); assert.equal(await meta(), version);
      await rpc(f, n.telemetryContext, 'damage', ['remove-upgrade-write']); const recorded = await call(f, c, 'sample', next); assert.equal(recorded.result.status, 'recorded'); assert.equal(await meta(), 4);
      await call(f, c, 'sample', { ...next, network: network(1) }, 409);
      const expanded = await rpc(f, n.telemetryContext, 'inspect'); await f.restart(); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), expanded); assert.deepEqual(await call(f, c, 'sample', next), recorded);
      f.bindings.TELEMETRY_READER = 'disk'; await f.restart();
      await call(f, c, 'read', { protocolVersion: 2 }, 409); await call(f, c, 'start', { protocolVersion: 2, bootId: randomUUID(), previousGeneration: 1 }, 409); await call(f, c, 'sample', first.input, 409);
      assert.equal((await f.call(n.path, { token: n.token })).status, 409); assert.deepEqual(await rpc(f, n.telemetryContext, 'inspect'), expanded);
      f.bindings.TELEMETRY_READER = 'current'; await f.restart(); assert.deepEqual((await f.call(n.path, { token: n.token })).json().sample, recorded.result.sample);
      const { sampleVersion: ignoredVersion, memory: ignoredMemory, disk: ignoredDisk, ...cpuOnly } = first.input;
      for (const [index, old] of [cpuOnly, { ...cpuOnly, sampleVersion: 2, memory: memory() }, { ...cpuOnly, sampleVersion: 3, memory: memory(), disk: disk() }].entries()) {
        await rpc(f, n.telemetryContext, 'damage', ['age', 90000]); const result = await call(f, c, 'sample', { ...old, sequence: 3 + index }); assert.equal(result.result.status, 'recorded'); assert.equal(Object.hasOwn(result.result.sample, 'network'), false); assert.equal(await meta(), 4);
      }
      await f.restart(); assert.equal(await meta(), 4);
    }
  } finally { await f.close(); }
});
test('network failure is independent and schema3 with v4 latest fails closed without repairing; four-metric identity isolation persists', async () => {
  const f = await adminFixture(telemetryFlags, telemetryOptions);
  try {
    const a = await telemetryNode(f), b = await telemetryNode(f), other = await telemetryNode(f, { sub: 'other-network-owner' });
    const failed = { ...network(), status: 'unavailable', reason: 'report-too-large', sampledAt: null, intervalMs: null, interfaces: [] };
    const first = await telemetrySample(f, a.roles.observe, cpu(), memory(), disk(), failed);
    await telemetrySample(f, b.roles.observe, cpu(1), memory(1), disk(1), network(300)); await telemetrySample(f, other.roles.observe, cpu(2), memory(2), disk(2), network(600));
    await call(f, { ...b.roles.observe, nodeId: a.context.nodeId }, 'sample', first.input, 409);
    await call(f, a.roles.execute, 'sample', first.input, 404);
    assert.equal((await f.call(a.path, { token: other.token })).status, 409);
    const snapshots = await Promise.all([a, b, other].map(async n => (await f.call(n.path, { token: n.token })).json()));
    assert.deepEqual(snapshots[0].sample.network, failed); assert.equal(snapshots[0].sample.disk.status, 'available'); assert.equal(snapshots[1].sample.network.interfaces[0].rxBytes, 300); assert.equal(snapshots[2].sample.network.interfaces[0].rxBytes, 600);
    await rpc(f, a.telemetryContext, 'damage', ['schema-three']); const before = await rpc(f, a.telemetryContext, 'inspect'); await f.restart();
    await call(f, a.roles.observe, 'read', { protocolVersion: 2 }, 409); assert.equal((await f.call(a.path, { token: a.token })).status, 409); assert.deepEqual(await rpc(f, a.telemetryContext, 'inspect'), before);
  } finally { await f.close(); }
});
