import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { networkSample, networkReport, MAX_NETWORK_REPORT_BYTES, V4_DISK_REPORT_BYTES } from '../public/cloud-admin/network-contract.mjs';
import { diskSample, diskReport } from '../public/cloud-admin/disk-contract.mjs';
import { telemetryInput, telemetryTransition, telemetryResult, verifyTelemetryResult } from '../cloud/telemetry-contract.mjs';
import { openTelemetryClient } from '../src/node-telemetry/client.mjs';
import { createNetworkSampler } from '../src/node-telemetry/network.mjs';
import { RetryableNodeError } from '../src/node-credentials/client.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';
import { cpu, memory, disk, network } from './telemetry-data.mjs';
const size = value => Buffer.byteLength(JSON.stringify(value));
const bootId = randomUUID();
const input = net => ({ protocolVersion: 2, bootId, generation: 1, sequence: 1, cpu: cpu(), sampleVersion: 4, memory: memory(), disk: disk(), network: net });
const failed = reason => ({ ...network(), status: 'unavailable', reason, sampledAt: null, intervalMs: null, interfaces: [] });
function budgetNetwork(bytes) {
  const n = network(); n.interfaces = [];
  for (let i = 0; i < 256; i++) { const row = { ...network().interfaces[0], name: `e${i}` }; if (size({ ...n, interfaces: [...n.interfaces, row] }) > bytes) break; n.interfaces.push(row); }
  let remaining = bytes - size(n);
  for (const row of n.interfaces) { const count = Math.min(15 - row.name.length, remaining); row.name += 'x'.repeat(count); remaining -= count; }
  assert.equal(remaining, 0); assert.equal(size(n), bytes); return n;
}
function budgetDisk(bytes) { const d = disk(); d.mounts[0].mountPoint += 'x'.repeat(bytes - size(d)); assert.equal(size(d), bytes); return d; }

test('v6 SQLite reader retains exact committed schema-three contract/store/disk source', () => {
  const root = new URL('./fixtures/telemetry-v3/', import.meta.url), source = JSON.parse(readFileSync(new URL('source.json', root)));
  assert.equal(source.revision, 'c54402075af1f6f770cece47414287abc0930203');
  assert.deepEqual(source.files.map(f => f.sha256), ['93ea2a925be18c9b49f1cf9fc069f701cc8af063841fd11f9ee4c61ee846ff18', '83257c1e4e99523b80f3d5d91bdc41c91ddfb8d67d2bc5d96c2c04371c404fd4', '3588ba440568bb153080654b73a6f0f3a3c7be08728bde5ad41cb7c7bb83df5c']);
  for (const f of source.files) {
    let text = readFileSync(new URL(f.fixture, root), 'utf8').replaceAll("'../../../cloud/", "'./").replace("'./contract.mjs'", "'./telemetry-contract.mjs'");
    if (f.fixture === 'contract.mjs') text = text.replace("'./disk-contract.mjs'", "'../public/cloud-admin/disk-contract.mjs'");
    assert.equal(createHash('sha256').update(text).digest('hex'), f.sha256);
  }
});
test('network shared contract validates zero/nonzero, baseline unknown, partial and exact fixed fields without accepting private data', () => {
  for (const n of [network(), network(1, 300), failed('read-failed'), failed('report-too-large')]) assert.deepEqual(networkSample(n), n);
  const unknown = { ...network(), status: 'unknown', reason: 'warming-up', intervalMs: null, interfaces: [{ ...network().interfaces[0], status: 'unknown', reason: 'warming-up', rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null }] };
  assert.deepEqual(networkSample(unknown), unknown);
  const partial = network(); partial.status = 'partial'; partial.reason = 'interface-unavailable'; partial.interfaces.push({ ...unknown.interfaces[0], name: 'lo', reason: 'counter-regressed' }); assert.deepEqual(networkSample(partial), partial);
  for (const patch of [{ status: 'unknown' }, { reason: 'raw error' }, { sampledAt: null }, { intervalMs: 29999 }, { intervalMs: Infinity }, { intervalMs: Number.MAX_SAFE_INTEGER }, { scope: 'host' }, { extra: 'private' }]) assert.throws(() => networkSample({ ...network(), ...patch }));
  for (const patch of [{ name: '../bad' }, { name: '<img>' }, { name: '注' }, { name: '1234567890123456' }, { rxBytes: -1 }, { txBytes: 0.5 }, { rxBytes: Number.MAX_SAFE_INTEGER + 1 }, { rxBytesPerSecond: 1 }, { txBytesPerSecond: 0.001 }, { status: 'unknown', reason: 'counter-regressed' }, { ip: 'private' }]) { const n = network(); Object.assign(n.interfaces[0], patch); assert.throws(() => networkSample(n)); }
  const duplicate = network(); duplicate.interfaces.push({ ...duplicate.interfaces[0] }); assert.throws(() => networkSample(duplicate));
  assert.throws(() => networkSample({ ...failed('read-failed'), interfaces: network().interfaces }));
  assert.throws(() => networkSample({ ...unknown, interfaces: [{ ...unknown.interfaces[0], reason: 'counter-regressed' }] }));
});
test('shared network contract accepts real sampler precision and mixed/unknown reset results', async () => {
  let now = 0n, rx = 0n, tx = 0n;
  const sampler = createNetworkSampler({ monotonic: () => now, wallClock: () => 0, readCounters: async () => ({ bootId: '12345678-1234-1234-1234-123456789abc\n', namespace: 'net:[123]', text: `Inter-| Receive | Transmit\nface |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\nlo: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n` }) });
  assert.equal(networkSample(await sampler.sample()).reason, 'warming-up');
  for (const [interval, delta] of [[30000123456n, 1n], [30000000001n, 12345678901n], [9007199254740991n, 123456789012345n]]) { now += interval; rx += delta; tx += delta; const n = await sampler.sample(); assert.equal(networkSample(n).status, 'available'); }
  now += 30000000000n; rx = 0n; assert.equal(networkSample(await sampler.sample()).interfaces[0].reason, 'counter-regressed');
});
test('v4 uses exact 3KiB budgets per whole metric while legacy v3 disk remains 6KiB and full requests/ACKs fit 8KiB', () => {
  assert.equal(MAX_NETWORK_REPORT_BYTES, 3072); assert.equal(V4_DISK_REPORT_BYTES, 3072);
  const n = budgetNetwork(3072), big = budgetNetwork(3073), d = budgetDisk(3072);
  assert.deepEqual(networkSample(n), n); assert.throws(() => networkSample(big)); assert.deepEqual(networkReport(big), failed('report-too-large')); assert.equal(big.interfaces.length > 1, true);
  assert.deepEqual(diskSample(d, 3072), d); assert.throws(() => diskSample(budgetDisk(3073), 3072)); assert.equal(diskReport(budgetDisk(3073), 3072).reason, 'report-too-large'); assert.deepEqual(diskSample(budgetDisk(3073)), budgetDisk(3073));
  const full = { ...input(n), disk: d, generation: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER, cpu: { ...cpu(), intervalMs: Number.MAX_SAFE_INTEGER, logicalCpuCount: 8192 }, memory: memory(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
  const normalized = telemetryInput('sample', full); assert.ok(size(normalized) <= 8192);
  const { protocolVersion, ...payload } = normalized;
  assert.ok(size(telemetryResult({ ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID() }, { status: 'recorded', sample: { ...payload, receivedAt: 8640000000000000 } })) <= 8192);
  assert.throws(() => telemetryInput('sample', { ...full, disk: budgetDisk(3073) }));
});
test('v4 exact shape and every network field are bound to replay and ACK; legacy payloads keep original shape', () => {
  const value = input(network()), context = { ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID() }, credential = { ...context, role: 'observe' };
  const start = telemetryTransition(null, 'start', { protocolVersion: 2, bootId, previousGeneration: 0 }, 0), recorded = telemetryTransition(start.state, 'sample', value, 0), ack = telemetryResult(context, recorded.result);
  assert.deepEqual(telemetryTransition(recorded.state, 'sample', value, 90000).result, recorded.result); assert.deepEqual(verifyTelemetryResult(ack, credential, 'sample', value), recorded.result);
  for (const net of [network(1), { ...network(), sampledAt: new Date(1).toISOString() }, { ...network(), interfaces: [{ ...network().interfaces[0], name: 'lo' }] }, failed('read-failed')]) {
    assert.throws(() => telemetryTransition(recorded.state, 'sample', { ...value, network: net }, 90000));
    assert.throws(() => verifyTelemetryResult({ ...ack, result: { ...recorded.result, sample: { ...recorded.result.sample, network: net } } }, credential, 'sample', value));
  }
  for (const patch of [{ network: undefined }, { sampleVersion: 3 }, { sampleVersion: 5 }, { memory: undefined }, { disk: undefined }, { extra: true }]) assert.throws(() => telemetryInput('sample', { ...value, ...patch }));
  const { network: ignored, ...v3 } = value; v3.sampleVersion = 3; assert.deepEqual(telemetryInput('sample', v3), v3); assert.throws(() => telemetryTransition(recorded.state, 'sample', v3, 90000));
});
test('new observe client holds network/disk pending unchanged across lost ACK and drops by original age; metric oversize stays local', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe');
  try {
    for (const mode of ['normal', 'oversize', 'stop', 'age', 'before-age']) {
      let now = 0, state = null, lost = true, calls = 0; const requests = [], stop = new AbortController();
      const client = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, bootId, monotonic: () => now, sampler: { sample: async () => cpu() }, memorySampler: { sample: async () => memory() }, diskSampler: { sample: async () => disk() }, networkSampler: { sample: async () => { calls++; if (mode === 'stop') stop.abort(); if (mode === 'age') now = 90000; if (mode === 'before-age') now = 89999; return mode === 'oversize' ? budgetNetwork(3073) : network(300); } }, fetcher: (url, init) => {
        const operation = url.split('/').at(-1), payload = JSON.parse(init.body); requests.push({ operation, payload }); assert.ok(size(payload) <= 8192);
        const result = telemetryTransition(state, operation, payload, now); state = result.state;
        if (operation === 'sample' && lost && mode === 'normal') { lost = false; throw new RetryableNodeError(); }
        return Response.json(telemetryResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId, enrollmentId: r.credential.enrollmentId }, result.result));
      } });
      if (mode === 'normal') { await assert.rejects(client.upload(stop.signal), RetryableNodeError); assert.equal(await client.upload(stop.signal), 'recorded'); const sent = requests.filter(r => r.operation === 'sample'); assert.deepEqual(sent[0].payload, sent[1].payload); assert.equal(calls, 1); assert.equal(state.latest.sampleVersion, 4); assert.equal(state.latest.network.interfaces[0].rxBytes, 300); }
      else { assert.equal(await client.upload(stop.signal), mode === 'stop' ? undefined : mode === 'age' ? 'dropped' : 'recorded'); assert.equal(requests.length, mode === 'stop' ? 0 : mode === 'age' ? 2 : 3); if (mode === 'oversize') { assert.equal(state.latest.network.reason, 'report-too-large'); assert.equal(state.latest.disk.status, 'available'); assert.equal(state.latest.cpu.status, 'available'); assert.equal(state.latest.memory.status, 'available'); } }
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
