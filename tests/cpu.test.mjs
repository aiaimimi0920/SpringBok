import test from 'node:test';
import assert from 'node:assert/strict';
import { CPU_INTERVAL_MS, parseCpuStat, createCpuSampler } from '../src/node-telemetry/cpu.mjs';
import { runCpuLoop } from '../src/node-telemetry/loop.mjs';

const stamp = Date.parse('2026-10-05T16:00:00Z');
const values = [100n, 20n, 30n, 400n, 50n, 6n, 7n, 8n, 10n, 2n];
function stat(v = values, cores = ['0', '1']) { return ['cpu ' + v.join(' '), ...cores.map(id => 'cpu' + id + ' ' + v.join(' ')), 'intr 123', 'ctxt 456'].join('\n') + '\n'; }
function fixture() {
  let text = stat(), now = 0, time = stamp;
  return { sampler: createCpuSampler({ readStat: async () => { if (text instanceof Error) throw text; return text; }, monotonic: () => now, wallClock: () => time }),
    set: (data, ms = CPU_INTERVAL_MS, clock = stamp + ms) => { text = data; now = ms; time = clock; } };
}
const add = delta => values.map((v, i) => v + BigInt(delta[i] ?? 0));

test('CPU parser bounds strict ten-column unsigned counters, duplicate IDs and CPU count; unrelated proc data is not returned', () => {
  const rows = parseCpuStat(stat()); assert.equal(rows.size, 3); assert.deepEqual(rows.get('cpu'), values);
  for (const text of ['', 'cpu 1 2 3 4\n', stat() + 'cpu0 ' + values.join(' '), stat().replace('cpu0', 'cpu00'), stat().replace('cpu1', 'cpux'), stat().replace('100', '-1'), stat().replace('100', 'NaN'), stat().replace('100', '18446744073709551616'), stat().replace('100', '9'), 'x'.repeat(1048577), stat(values, [])]) assert.throws(() => parseCpuStat(text));
  assert.throws(() => parseCpuStat(stat(values, Array.from({ length: 8193 }, (_, i) => String(i)))));
});

test('CPU usage is a 0-100 aggregate ratio, excludes iowait from busy and never double-counts guest; zero is a valid idle sample', async () => {
  const f = fixture();
  const first = await f.sampler.sample(); assert.equal(first.status, 'unknown'); assert.equal(first.reason, 'warming-up'); assert.equal(first.usagePercent, null); assert.equal(first.logicalCpuCount, 2);
  f.set(stat(add([20, 10, 10, 40, 10, 3, 2, 5, 15, 8])));
  assert.deepEqual(await f.sampler.sample(), { schema: 'springbok-cpu/v1', metric: 'cpu', scope: 'linux-proc-stat', unit: 'percent', status: 'available', reason: null, sampledAt: new Date(stamp + 30000).toISOString(), logicalCpuCount: 2, intervalMs: 30000, usagePercent: 50 });
  const idle = fixture(); await idle.sampler.sample(); idle.set(stat(add([0, 0, 0, 500]))); assert.equal((await idle.sampler.sample()).usagePercent, 0);
  const busy = fixture(); await busy.sampler.sample(); busy.set(stat(add([500]))); assert.equal((await busy.sampler.sample()).usagePercent, 100);
});

test('BigInt counters above Number.MAX_SAFE_INTEGER preserve small differences and rounding', async () => {
  const big = values.map(v => v + 9007199254740993n); const f = fixture(); f.set(stat(big), 0, stamp); await f.sampler.sample();
  f.set(stat(big.map((v, i) => v + (i === 0 ? 1n : i === 3 ? 2n : 0n)))); assert.equal((await f.sampler.sample()).usagePercent, 33.33);
});

test('CPU changes, no progress and all counter regressions (including iowait) stay unknown and rebaseline', async () => {
  for (const next of [stat(), stat(add([5]), ['0', '2']), stat(add([5]), ['0']), ...values.map((_, i) => stat(values.map((v, j) => j === i ? v - 1n : v)))]) {
    const f = fixture(); await f.sampler.sample(); f.set(next); const result = await f.sampler.sample();
    assert.equal(result.status, 'unknown'); assert.equal(result.usagePercent, null);
    if (next === stat()) assert.equal(result.reason, 'no-counter-progress');
  }
  const f = fixture(); await f.sampler.sample(); f.set(stat(values.map(v => v - 1n))); await f.sampler.sample();
  f.set(stat(add([10])), 60000); assert.equal((await f.sampler.sample()).status, 'available');
});

test('minimum interval uses monotonic time; early calls do not advance baseline; clock faults do not yield numbers', async () => {
  assert.equal(CPU_INTERVAL_MS, 30000);
  const f = fixture(); await f.sampler.sample(); f.set(stat(add([50, 0, 0, 50])), 29999, stamp + 100000);
  assert.equal((await f.sampler.sample()).reason, 'interval-too-short'); f.set(stat(add([50, 0, 0, 50]))); assert.equal((await f.sampler.sample()).usagePercent, 50);
  for (const [ms, clock, reason] of [[0, stamp, 'clock-regressed'], [30000, stamp - 1, 'clock-regressed'], [NaN, stamp, 'clock-unavailable'], [Infinity, stamp, 'clock-unavailable'], [Number.MAX_VALUE, stamp, 'clock-unavailable'], [30000, NaN, 'clock-unavailable'], [30000, 8640000000000001, 'clock-unavailable']]) {
    const f = fixture(); await f.sampler.sample(); f.set(stat(add([10])), ms, clock); const r = await f.sampler.sample(); assert.equal(r.reason, reason); assert.equal(r.usagePercent, null);
  }
});

test('read and parse failures discard baseline, expose only fixed reasons, recover through warm-up and prevent overlap', async () => {
  const f = fixture(); await f.sampler.sample();
  for (const [data, reason] of [[new Error('secret path error'), 'read-failed'], ['broken private contents', 'invalid-counters']]) {
    f.set(data); const r = await f.sampler.sample(); assert.equal(r.status, 'unavailable'); assert.equal(r.reason, reason); assert.equal(r.usagePercent, null); assert.ok(!JSON.stringify(r).includes('private'));
    f.set(stat()); assert.equal((await f.sampler.sample()).reason, 'warming-up');
  }
  let finish; const sampler = createCpuSampler({ readStat: () => new Promise(resolve => { finish = resolve; }) }); const sample = sampler.sample();
  await assert.rejects(sampler.sample(), /already running/); finish(stat()); assert.equal((await sample).reason, 'warming-up');
});

test('CPU loop is serial, always waits 30s (including unavailable), stops promptly and discards in-flight samples after stop', async () => {
  const stop = new AbortController(), waits = [], results = []; let calls = 0, active = 0;
  await runCpuLoop({ signal: stop.signal, sampler: { sample: async () => { assert.equal(++active, 1); await Promise.resolve(); active--; return ++calls; } }, onSample: s => results.push(s), wait: async ms => { waits.push(ms); if (waits.length === 3) stop.abort(); } });
  assert.deepEqual(waits, [30000, 30000, 30000]); assert.deepEqual(results, [1, 2, 3]);
  const drain = new AbortController(); let finish, emitted = 0;
  const running = runCpuLoop({ signal: drain.signal, sampler: { sample: () => new Promise(resolve => { finish = resolve; }) }, onSample: () => emitted++, wait: () => { throw new Error('no wait'); } });
  drain.abort(); finish({ status: 'available' }); await running; assert.equal(emitted, 0);
  const sleep = new AbortController(); let samples = 0;
  const sleeping = runCpuLoop({ signal: sleep.signal, sampler: { sample: async () => { samples++; } }, onSample: () => {} });
  await new Promise(resolve => setImmediate(resolve)); sleep.abort(); await sleeping; assert.equal(samples, 1);
  await runCpuLoop({ signal: sleep.signal, sampler: { sample: () => { throw new Error('no sample'); } }, onSample: () => {} });
  await assert.rejects(runCpuLoop({ signal: new AbortController().signal, sampler: { sample: async () => 1 }, onSample: () => {}, wait: () => { throw new Error('invalid wait'); } }));
});
