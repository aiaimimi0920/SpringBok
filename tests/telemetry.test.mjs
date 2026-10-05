import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { rmSync, readFileSync } from 'node:fs';
import { cpuSample, memorySample, telemetryInput, telemetryState, telemetryTransition as transition, telemetryResult, telemetrySnapshot, verifyTelemetryResult } from '../cloud/telemetry-contract.mjs';
import { openTelemetryClient } from '../src/node-telemetry/client.mjs';
import { RetryableNodeError } from '../src/node-credentials/client.mjs';
import { runNodeLoop } from '../src/node-daemon/loop.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';
import { cpu, memory } from './telemetry-data.mjs';

const context = { ownerId: 'a'.repeat(64), nodeId: randomUUID() }, bootId = randomUUID();
const start = (boot = bootId, previousGeneration = 0) => ({ protocolVersion: 2, bootId: boot, previousGeneration });
const sample = (data = cpu(), sequence = 1, boot = bootId, generation = 1) => ({ protocolVersion: 2, bootId: boot, generation, sequence, cpu: data });
const v2 = (m = memory()) => ({ ...sample(), sampleVersion: 2, memory: m });
test('legacy SQLite reader fixture is the exact published baseline apart from relative import relocation', () => {
  const root = new URL('./fixtures/telemetry-v1/', import.meta.url), source = JSON.parse(readFileSync(new URL('source.json', root), 'utf8'));
  assert.equal(source.revision, '202d658ad066aa0d6d5ed8e27bc2f0ce0403518e');
  assert.deepEqual(source.files.map(f => f.sha256), ['d33a6eee3a099e2a2c7eb64bf262ab0972ceee08687f709321f5c7702d66955f', 'e2ad661280220e1ae31ea2dbdd0fd081249ab349883983443ca945780a084b63']);
  for (const f of source.files) {
    const text = readFileSync(new URL(f.fixture, root), 'utf8').replaceAll("'../../../cloud/", "'./").replace("'./contract.mjs'", "'./telemetry-contract.mjs'");
    assert.equal(createHash('sha256').update(text).digest('hex'), f.sha256);
  }
});
test('memory contract validates strict byte gauge, exact percentage, null reasons and explicit sample union without changing legacy shape', () => {
  for (const m of [memory(), memory(1, 3), memory(3, 3), memory(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)]) assert.deepEqual(memorySample(m), m);
  for (const reason of ['read-failed', 'invalid-meminfo', 'memavailable-missing', 'clock-unavailable']) {
    const m = { ...memory(), status: 'unavailable', reason, sampledAt: null, totalBytes: null, availableBytes: null, usedBytes: null, usagePercent: null };
    assert.deepEqual(memorySample(m), m); assert.throws(() => memorySample({ ...m, usedBytes: 0 }));
  }
  for (const bad of [{ totalBytes: 0 }, { totalBytes: -1 }, { totalBytes: Number.MAX_SAFE_INTEGER + 1 }, { availableBytes: 1073741825 }, { usedBytes: 1 }, { usagePercent: null }, { usagePercent: NaN }, { usagePercent: 1 }, { availableBytes: 0.1 }, { status: 'unknown' }, { reason: 'read-failed' }, { sampledAt: 'invalid' }, { unit: 'kB' }, { scope: 'host' }, { extra: true }]) assert.throws(() => memorySample({ ...memory(), ...bad }));
  assert.deepEqual(telemetryInput('sample', sample()), sample()); assert.deepEqual(telemetryInput('sample', v2()), v2());
  for (const bad of [{ ...sample(), memory: memory() }, { ...sample(), sampleVersion: 2 }, { ...v2(), sampleVersion: 1 }, { ...v2(), sampleVersion: 3 }, { ...v2(), extra: true }]) assert.throws(() => telemetryInput('sample', bad));
});
test('versioned replay and recorded ACK compare the entire CPU/memory/version payload', () => {
  const credential = { ...context, enrollmentId: randomUUID(), role: 'observe' };
  const first = transition(transition(null, 'start', start(), 0).state, 'sample', v2(), 0);
  assert.deepEqual(transition(first.state, 'sample', v2(), 999999).result, first.result);
  for (const changed of [v2(memory(1)), sample(), { ...v2(), cpu: cpu(1) }]) assert.throws(() => transition(first.state, 'sample', changed, 999999));
  const ack = telemetryResult({ ...context, enrollmentId: credential.enrollmentId }, first.result); assert.deepEqual(verifyTelemetryResult(ack, credential, 'sample', v2()), first.result);
  for (const changed of [memory(1), { ...memory(), status: 'unavailable', reason: 'read-failed', sampledAt: null, totalBytes: null, availableBytes: null, usedBytes: null, usagePercent: null }]) assert.throws(() => verifyTelemetryResult({ ...ack, result: { ...ack.result, sample: { ...first.result.sample, memory: changed } } }, credential, 'sample', v2()));
  const { sampleVersion, memory: ignored, ...old } = first.result.sample;
  assert.throws(() => verifyTelemetryResult({ ...ack, result: { ...ack.result, sample: old } }, credential, 'sample', v2()));
});
test('CPU upload contract preserves zero/null and strictly rejects malformed status, scope, fields, units and bounds', () => {
  assert.equal(cpuSample(cpu()).usagePercent, 0);
  const unknown = { ...cpu(), status: 'unknown', reason: 'warming-up', intervalMs: null, usagePercent: null }, unavailable = { ...unknown, status: 'unavailable', reason: 'read-failed', sampledAt: null, logicalCpuCount: null };
  assert.deepEqual(cpuSample(unknown), unknown); assert.deepEqual(cpuSample(unavailable), unavailable);
  for (const bad of [{ usagePercent: null }, { usagePercent: NaN }, { usagePercent: 101 }, { usagePercent: -1 }, { intervalMs: 29999 }, { logicalCpuCount: 0 }, { logicalCpuCount: 8193 }, { sampledAt: 'invalid' }, { sampledAt: -1 }, { reason: 'warming-up' }, { unit: 'cores' }, { scope: 'host' }, { metric: 'memory' }, { token: 'extra' }]) assert.throws(() => cpuSample({ ...cpu(), ...bad }));
  for (const bad of [{ ...unknown, reason: null }, { ...unknown, usagePercent: 0 }, { ...unavailable, logicalCpuCount: 1 }, { ...unavailable, reason: 'arbitrary failure' }]) assert.throws(() => cpuSample(bad));
  for (const sequence of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => telemetryInput('sample', sample(cpu(), sequence)));
  assert.throws(() => telemetryInput('read', { protocolVersion: 2, ownerId: context.ownerId })); assert.throws(() => telemetryInput('start', start(bootId, Number.MAX_SAFE_INTEGER)));
});
test('independent bounded latest uses full-payload replay, session CAS, cross-boot rate, generation/sequence and cloud time', () => {
  let state = transition(null, 'start', start(), 1000).state;
  const first = transition(state, 'sample', sample(), 1000); state = first.state;
  assert.deepEqual(transition(state, 'sample', sample(), 500000).result, first.result);
  assert.throws(() => transition(state, 'sample', sample(cpu(1)), 500000));
  assert.equal(transition(state, 'sample', sample(cpu(1), 2), 30999).result.status, 'deferred');
  const second = transition(state, 'sample', sample(cpu(1), 2), 31000); state = second.state;
  assert.throws(() => transition(state, 'sample', sample(), 500000));
  const nextBoot = randomUUID(); state = transition(state, 'start', start(nextBoot, 1), 31001).state;
  assert.equal(transition(state, 'sample', sample(cpu(), 1, nextBoot, 2), 32000).result.status, 'deferred');
  assert.throws(() => transition(state, 'sample', sample(cpu(), 9999), 500000));
  assert.throws(() => transition(state, 'start', start(randomUUID(), 1), 500000));
  assert.throws(() => transition(state, 'start', start(bootId, 2), 500000));
  assert.equal(transition(state, 'start', start(nextBoot, 1), 500000).changed, false);
  state = transition(state, 'sample', sample(cpu(), 1, nextBoot, 2), 61000).state;
  assert.throws(() => transition(state, 'sample', sample(cpu(), 2, nextBoot, 2), 60999));
  for (const [now, expected] of [[61000, 'fresh'], [150999, 'fresh'], [151000, 'stale'], [60999, 'unknown']]) assert.equal(telemetrySnapshot(context, state, now).freshness, expected);
  assert.equal(telemetrySnapshot(context, state, 61000, false).freshness, 'unknown');
  assert.throws(() => telemetryState({ ...state, latest: { ...state.latest, generation: 3 } }));
  assert.equal(Object.keys(state).length, 4); assert.equal(Object.keys(state.latest).length, 5);
});
test('observe telemetry client reuses lost CAS/receipt, ages pending by monotonic time and never relabels the old CPU payload', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe'); let state = null, time = 0, samples = 0, memorySamples = 0, lostStart = true, lostSample = true; const requests = [];
  try {
    const fetcher = async (url, init) => {
      const operation = new URL(url).pathname.split('/').at(-1), input = JSON.parse(init.body); requests.push({ operation, input });
      assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, `Bearer ${r.credential.token}`);
      const result = transition(state, operation, input, 1000 + time); state = result.state;
      if (operation === 'start' && lostStart) { lostStart = false; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' }); }
      if (operation === 'sample' && lostSample) { lostSample = false; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' }); }
      return Response.json(telemetryResult({ ...context, ownerId: r.credential.ownerId, nodeId: r.credential.nodeId, enrollmentId: r.credential.enrollmentId }, result.result));
    };
    const client = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, fetcher, monotonic: () => time, sampler: { sample: async () => cpu(++samples) }, memorySampler: { sample: async () => memory(++memorySamples) } }), signal = new AbortController().signal;
    await assert.rejects(client.upload(signal), RetryableNodeError); await assert.rejects(client.upload(signal), RetryableNodeError);
    assert.equal(await client.upload(signal), 'recorded'); assert.equal(samples, 1); assert.equal(memorySamples, 1); assert.equal(state.latest.sampleVersion, 2); assert.equal(state.latest.memory.usedBytes, 1);
    for (const operation of ['start', 'sample']) { const inputs = requests.filter(r => r.operation === operation).map(r => r.input); assert.deepEqual(inputs[0], inputs[1]); }
    assert.equal(state.latest.receivedAt, 1000);
    time = 30000; lostSample = true; await assert.rejects(client.upload(signal), RetryableNodeError);
    const old = requests.at(-1).input; time = 120000; assert.equal(await client.upload(signal), 'recorded');
    const next = requests.at(-1).input; assert.equal(next.cpu.usagePercent, 3); assert.equal(next.memory.usedBytes, 3); assert.equal(next.sequence, old.sequence + 1); assert.notDeepEqual(next.cpu, old.cpu); assert.notDeepEqual(next.memory, old.memory);
    const stop = new AbortController(); stop.abort(); const count = requests.length; await client.upload(stop.signal); assert.equal(requests.length, count);
    assert.throws(() => openTelemetryClient({ file: roleFixture(f.directory, 'execute').credentialFile, expectedOrigin: r.credential.origin }));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test('telemetry age and stop boundaries discard a late collection before upload and wrong-scope replies fail closed', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe');
  try {
    let time = 0, calls = 0;
    const client = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, monotonic: () => time, sampler: { sample: async () => { time = 90000; return cpu(); } }, fetcher: (url) => {
      calls++; return Response.json(telemetryResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId, enrollmentId: r.credential.enrollmentId }, url.endsWith('/read') ? { generation: 0 } : { generation: 1, bootId }));
    }, bootId });
    assert.equal(await client.upload(new AbortController().signal), 'dropped'); assert.equal(calls, 2);
    const stop = new AbortController(), stopped = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, sampler: { sample: async () => { stop.abort(); return cpu(); } }, fetcher: () => { throw new Error('must not call'); } }); await stopped.upload(stop.signal);
    const wrong = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, sampler: { sample: async () => cpu() }, fetcher: () => Response.json(telemetryResult({ ...context, enrollmentId: r.credential.enrollmentId }, { generation: 0 })) }); await assert.rejects(wrong.upload(new AbortController().signal));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test('non-transient telemetry rejection disables only telemetry; transient upload failure never changes task poll backoff', async () => {
  for (const error of [new Error('telemetry identity denied'), new RetryableNodeError()]) {
    const stop = new AbortController(), events = []; let polls = 0, beats = 0, uploads = 0, waits = 0;
    const result = await runNodeLoop({ signal: stop.signal, step: async () => { polls++; return 'idle'; }, heartbeat: async () => { beats++; return 'recorded'; }, telemetry: async () => { uploads++; throw error; }, random: () => 0, wait: async ms => { assert.equal(ms, 30000); if (++waits === 3) stop.abort(); }, onEvent: event => events.push(event) });
    assert.equal(result, 'stopped'); assert.equal(polls, 3); assert.equal(beats, 3); assert.equal(uploads, error instanceof RetryableNodeError ? 3 : 1);
    assert.equal(events.some(e => e.event === 'telemetry' && e.status === (error instanceof RetryableNodeError ? 'unavailable' : 'unconfirmed')), true);
  }
});
test('memory collection stop and 90-second age boundaries do not publish a late dual-metric sample', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe');
  try {
    for (const boundary of ['stop', 'age', 'before-age']) {
      let time = 0, calls = 0, state = null; const stop = new AbortController();
      const client = openTelemetryClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, bootId, monotonic: () => time, sampler: { sample: async () => cpu() }, memorySampler: { sample: async () => { if (boundary === 'stop') stop.abort(); else time = boundary === 'age' ? 90000 : 89999; return memory(); } }, fetcher: (url, init) => { calls++; const result = transition(state, url.split('/').at(-1), JSON.parse(init.body), time); state = result.state; return Response.json(telemetryResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId, enrollmentId: r.credential.enrollmentId }, result.result)); } });
      assert.equal(await client.upload(stop.signal), boundary === 'age' ? 'dropped' : boundary === 'before-age' ? 'recorded' : undefined); assert.equal(calls, boundary === 'age' ? 2 : boundary === 'before-age' ? 3 : 0);
    }
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
