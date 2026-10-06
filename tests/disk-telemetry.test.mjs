import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { diskSample, diskReport, MAX_DISK_REPORT_BYTES } from '../public/cloud-admin/disk-contract.mjs';
import { telemetryInput, telemetryTransition, telemetryResult, verifyTelemetryResult } from '../cloud/telemetry-contract.mjs';
import { readCredentialResponse, RetryableNodeError } from '../src/node-credentials/client.mjs';
import { openTelemetryClient } from '../src/node-telemetry/client.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';
import { cpu, memory, disk } from './telemetry-data.mjs';
const bootId = randomUUID();
const input = d => ({ protocolVersion: 2, bootId, generation: 1, sequence: 1, cpu: cpu(), sampleVersion: 3, memory: memory(), disk: d });
const size = value => Buffer.byteLength(JSON.stringify(value));
function budgetDisk(bytes) {
  const d = disk(); d.mounts.push({ ...d.mounts[0], mountId: 2, mountPoint: '/b' });
  d.mounts[0].mountPoint = '/' + 'a'.repeat(3000);
  const padding = bytes - size(d); assert.ok(padding >= 0 && padding + 2 <= 4096);
  d.mounts[1].mountPoint += 'b'.repeat(padding); assert.equal(size(d), bytes); return d;
}
test('v5 SQLite reader retains the exact committed schema-two baseline and original checksums', () => {
  const root = new URL('./fixtures/telemetry-v2/', import.meta.url), source = JSON.parse(readFileSync(new URL('source.json', root)));
  assert.equal(source.revision, '6b1c6cb279e115d9ebfc5367e47bb908daa43a70');
  assert.deepEqual(source.files.map(f => f.sha256), ['774e17e556ec9d8bd1d4da1fb2b07d92ae80e16805cfcefd703335967fd541cb', 'dfe8fc5a4be7d87bf9fde9c74bf0e34c1e8c282b82307cf175608e9cc4df8458']);
  for (const f of source.files) {
    const text = readFileSync(new URL(f.fixture, root), 'utf8').replaceAll("'../../../cloud/", "'./").replace("'./contract.mjs'", "'./telemetry-contract.mjs'");
    assert.equal(createHash('sha256').update(text).digest('hex'), f.sha256);
  }
});
test('shared disk transport validates exact namespace gauges, partial failures, zero, null, counts and path identities', () => {
  for (const d of [disk(), disk(1), disk(1024), { ...disk(), status: 'unavailable', reason: 'no-supported-mounts', mounts: [] }]) assert.deepEqual(diskSample(d), d);
  const partial = disk(); partial.mounts.push({ ...partial.mounts[0], mountId: 2, mountPoint: '/data', status: 'unavailable', reason: 'statfs-failed', totalBytes: null, freeBytes: null, availableBytes: null, usedBytes: null, reservedBytes: null, usagePercent: null }); partial.status = 'partial'; partial.reason = 'mount-unavailable';
  assert.deepEqual(diskSample(partial), partial);
  for (const patch of [{ mountPoint: '//data' }, { mountPoint: '/data/' }, { mountPoint: '/a/../b' }, { mountPoint: 'relative' }, { mountPoint: '/\0' }, { mountPoint: '/\ud800' }, { device: '008:1' }, { fsType: 'overlay' }, { readOnly: 1 }, { totalBytes: 0 }, { freeBytes: 1025 }, { availableBytes: 1025 }, { reservedBytes: 1 }, { usedBytes: 1 }, { usagePercent: 1 }, { usedBytes: Number.MAX_SAFE_INTEGER + 1 }, { source: 'secret' }]) {
    const d = disk(); Object.assign(d.mounts[0], patch); assert.throws(() => diskSample(d));
  }
  for (const patch of [{ status: 'partial' }, { sampledAt: null }, { filtered: { pseudo: 4097, unsupported: 0, subtree: 0, unsafeTopology: 0 } }, { extra: 'raw' }]) assert.throws(() => diskSample({ ...disk(), ...patch }));
  for (const field of ['mountId', 'mountPoint']) { const d = disk(); d.mounts.push({ ...d.mounts[0], mountId: 2, mountPoint: '/b', [field]: d.mounts[0][field] }); assert.throws(() => diskSample(d)); }
  for (const reason of ['worker-timeout', 'worker-busy', 'read-failed', 'report-too-large']) {
    const d = { ...disk(), status: 'unavailable', reason, sampledAt: null, mounts: [], filtered: null }; assert.deepEqual(diskSample(d), d); assert.throws(() => diskSample({ ...d, mounts: disk().mounts }));
  }
});
test('6 KiB canonical UTF-8 report budget is exact and whole-result fail-closed, never mount/path truncation', () => {
  assert.equal(MAX_DISK_REPORT_BYTES, 6144);
  const fitting = budgetDisk(6144), large = budgetDisk(6145);
  assert.deepEqual(diskReport(fitting), fitting); assert.deepEqual(diskSample(fitting), fitting); assert.throws(() => diskSample(large));
  const report = diskReport(large); assert.equal(report.reason, 'report-too-large'); assert.deepEqual(report.mounts, []); assert.equal(report.filtered, null); assert.equal(report.sampledAt, null); assert.deepEqual(diskSample(report), report); assert.equal(large.mounts.length, 2);
  const multibyte = disk(1, '/' + '中'.repeat(1024)); assert.ok(size(multibyte) > JSON.stringify(multibyte).length); assert.deepEqual(diskSample(multibyte), multibyte);
  assert.throws(() => diskReport(disk(1, '/' + '中'.repeat(1366))));
  // 最大安全整数/ISO 和协议外壳仍有足够预算，ACK 也不超过原8KiB路由上限。
  const context = { ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID() }, full = { ...input(fitting), generation: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER, cpu: { ...cpu(), intervalMs: Number.MAX_SAFE_INTEGER, logicalCpuCount: 8192 }, memory: memory(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) };
  assert.ok(size(telemetryInput('sample', full)) <= 8192);
  assert.ok(size(telemetryResult(context, { status: 'recorded', sample: { ...full, receivedAt: 8640000000000000 } })) <= 8192);
});
test('disk sample version and entire namespace payload are bound to replay and recorded ACK', () => {
  const context = { ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID() }, credential = { ...context, role: 'observe' }, value = input(disk());
  assert.deepEqual(telemetryInput('sample', value), value);
  for (const patch of [{ sampleVersion: 2 }, { sampleVersion: 99 }, { disk: undefined }, { memory: undefined }, { sampleVersion: undefined }]) assert.throws(() => telemetryInput('sample', { ...value, ...patch }));
  const start = telemetryTransition(null, 'start', { protocolVersion: 2, bootId, previousGeneration: 0 }, 0), recorded = telemetryTransition(start.state, 'sample', value, 0), ack = telemetryResult(context, recorded.result);
  assert.deepEqual(telemetryTransition(recorded.state, 'sample', value, 90000).result, recorded.result);
  assert.deepEqual(verifyTelemetryResult(ack, credential, 'sample', value), recorded.result);
  for (const changed of [disk(1), disk(0, '/changed'), { ...disk(), filtered: { ...disk().filtered, pseudo: 1 } }]) {
    assert.throws(() => telemetryTransition(recorded.state, 'sample', { ...value, disk: changed }, 90000));
    assert.throws(() => verifyTelemetryResult({ ...ack, result: { ...recorded.result, sample: { ...recorded.result.sample, disk: changed } } }, credential, 'sample', value));
  }
  const { disk: ignored, ...v2 } = value; v2.sampleVersion = 2;
  assert.throws(() => telemetryTransition(recorded.state, 'sample', v2, 90000));
});
test('only explicit telemetry response reader opts into 8 KiB, with exact UTF-8 byte boundary and old 4 KiB unchanged', async () => {
  const response = bytes => new Response('{"ok":true}' + ' '.repeat(bytes - 11));
  assert.deepEqual(await readCredentialResponse(response(4096)), { ok: true }); await assert.rejects(readCredentialResponse(response(4097)), /large node response/);
  assert.deepEqual(await readCredentialResponse(response(8192), 8192), { ok: true }); await assert.rejects(readCredentialResponse(response(8193), 8192), /large node response/);
  await assert.rejects(readCredentialResponse(response(11), 16384), /invalid node response limit/);
});
test('observe client retains the same bounded disk payload across lost ACK without resampling, then ages it normally', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe'); let state = null, time = 0, disks = 0, lost = true; const requests = [];
  try {
    const client = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, bootId, sampler: { sample: async () => cpu() }, memorySampler: { sample: async () => memory() }, diskSampler: { sample: async () => { disks++; return budgetDisk(6144); } }, monotonic: () => time, fetcher: (url, init) => {
      const operation = url.split('/').at(-1), payload = JSON.parse(init.body); requests.push({ operation, payload }); assert.ok(Buffer.byteLength(init.body) <= 8192);
      const result = telemetryTransition(state, operation, payload, time); state = result.state;
      if (operation === 'sample' && lost) { lost = false; throw new RetryableNodeError(); }
      return Response.json(telemetryResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId, enrollmentId: r.credential.enrollmentId }, result.result));
    } });
    const signal = new AbortController().signal; await assert.rejects(client.upload(signal), RetryableNodeError); assert.equal(await client.upload(signal), 'recorded'); assert.equal(disks, 1);
    const sent = requests.filter(r => r.operation === 'sample'); assert.deepEqual(sent[0].payload, sent[1].payload); assert.equal(state.latest.sampleVersion, 4); assert.equal(state.latest.disk.reason, 'report-too-large'); assert.deepEqual(state.latest.disk.mounts, []);
    time = 30000; assert.equal(await client.upload(signal), 'recorded'); assert.equal(disks, 2);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test('disk collection stop, age and oversize outcomes do not disable CPU/memory or upload a late sample', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe');
  try {
    for (const mode of ['stop', 'age', 'before-age', 'oversize', 'timeout']) {
      let time = 0, state = null, calls = 0; const stop = new AbortController();
      const client = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, bootId, monotonic: () => time, sampler: { sample: async () => cpu() }, memorySampler: { sample: async () => memory() }, diskSampler: { sample: async () => {
        if (mode === 'stop') stop.abort(); if (mode === 'age') time = 90000; if (mode === 'before-age') time = 89999;
        return mode === 'oversize' ? budgetDisk(6145) : mode === 'timeout' ? { ...disk(), status: 'unavailable', reason: 'worker-timeout', sampledAt: null, mounts: [], filtered: null } : disk();
      } }, fetcher: (url, init) => { calls++; const result = telemetryTransition(state, url.split('/').at(-1), JSON.parse(init.body), time); state = result.state; return Response.json(telemetryResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId, enrollmentId: r.credential.enrollmentId }, result.result)); } });
      assert.equal(await client.upload(stop.signal), mode === 'stop' ? undefined : mode === 'age' ? 'dropped' : 'recorded'); assert.equal(calls, mode === 'stop' ? 0 : mode === 'age' ? 2 : 3);
      if (mode === 'oversize' || mode === 'timeout') { assert.equal(state.latest.cpu.status, 'available'); assert.equal(state.latest.memory.status, 'available'); assert.equal(state.latest.disk.reason, mode === 'oversize' ? 'report-too-large' : 'worker-timeout'); }
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
