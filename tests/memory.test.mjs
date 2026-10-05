import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { readProcMeminfo, parseMemoryInfo, createMemorySampler } from '../src/node-telemetry/memory.mjs';
import { COLLECTION_INTERVAL_MS, runSamplingLoop, runCpuLoop } from '../src/node-telemetry/loop.mjs';
import { CPU_INTERVAL_MS } from '../src/node-telemetry/cpu.mjs';

const time = Date.parse('2026-10-05T19:00:00Z');
const info = (total = '100', available = '40') => `MemTotal: ${total} kB\nMemAvailable: ${available} kB\nMemFree: 1 kB\nCached: 90 kB\nBuffers: 1 kB\nHugePages_Total: 0\n`;
const sampler = (readMeminfo, wallClock = () => time) => createMemorySampler({ readMeminfo, wallClock });
const assertUnavailable = (sample, reason) => {
  assert.equal(sample.status, 'unavailable'); assert.equal(sample.reason, reason);
  for (const key of ['sampledAt', 'totalBytes', 'availableBytes', 'usedBytes', 'usagePercent']) assert.equal(sample[key], null);
};

test('memory gauge uses MemAvailable, bytes and total-minus-available, not MemFree/cache/swap; first sample is available', async () => {
  const result = await sampler(async () => info()).sample();
  assert.deepEqual(result, { schema: 'springbok-memory/v1', metric: 'memory', scope: 'linux-proc-meminfo', unit: 'bytes', status: 'available', reason: null, sampledAt: new Date(time).toISOString(), totalBytes: 102400, availableBytes: 40960, usedBytes: 61440, usagePercent: 60 });
  assert.deepEqual(parseMemoryInfo(info().replace('MemFree: 1', 'MemFree: 99').replace('Cached: 90', 'Cached: 0') + 'SwapTotal: 9999 kB\nprivate line\n'), parseMemoryInfo(info()));
  assert.equal(JSON.stringify(result).includes('private'), false);
  for (const [available, percent, used] of [['100', 0, 0], ['0', 100, 102400]]) {
    const sample = await sampler(async () => info('100', available)).sample();
    assert.equal(sample.status, 'available'); assert.equal(sample.availableBytes, Number(available) * 1024); assert.equal(sample.usedBytes, used); assert.equal(sample.usagePercent, percent);
  }
  assert.equal(parseMemoryInfo(info('3', '2')).usagePercent, 33.33);
  assert.equal(parseMemoryInfo(info('3', '1')).usagePercent, 66.67);
});

test('memory parser rejects missing/zero total, duplicates, contradictions, units and malformed values; missing availability is distinct', async () => {
  const missing = 'MemTotal: 100 kB\nMemFree: 40 kB\nCached: 1 kB\n';
  assert.equal(parseMemoryInfo(missing), null); assertUnavailable(await sampler(async () => missing).sample(), 'memavailable-missing');
  for (const text of ['', 'MemAvailable: 40 kB', info('0', '0'), info('100', '101'), info() + 'MemTotal: 100 kB\n', info() + 'MemAvailable: 40 kB\n',
    ...['-1', '1.2', '1e3', 'NaN', 'Infinity', '01', '18446744073709551616'].flatMap(v => [info(v, '0'), info('100', v)]),
    info().replace('40 kB', '40 KB'), info().replace('100 kB', '100 bytes'), info().replace('40 kB', '40'), info().replace('40 kB', ' kB'),
    info().replace('MemAvailable:', 'MemAvailable '), missing.replace('100 kB', '-1 kB')]) {
    assert.throws(() => parseMemoryInfo(text)); assertUnavailable(await sampler(async () => text).sample(), 'invalid-meminfo');
  }
  assert.throws(() => parseMemoryInfo(null));
  const edge = parseMemoryInfo(info('8796093022207', '8796093022206'));
  assert.equal(edge.totalBytes, 9007199254739968); assert.equal(edge.availableBytes, 9007199254738944); assert.equal(edge.usedBytes, 1024);
  assert.throws(() => parseMemoryInfo(info('8796093022208', '0')));
});

test('memory bounds actual UTF-8 bytes including unrelated multibyte lines', () => {
  const prefix = info(), fill = '注'.repeat(1000), remaining = 65536 - Buffer.byteLength(prefix + fill);
  const valid = prefix + fill + 'x'.repeat(remaining);
  assert.equal(Buffer.byteLength(valid), 65536); assert.deepEqual(parseMemoryInfo(valid), parseMemoryInfo(prefix));
  assert.throws(() => parseMemoryInfo(valid + 'x'));
});

test('memory read/clock failures are fixed, clear all numbers and recover immediately; concurrent calls are rejected', async () => {
  let data = info(); const f = sampler(async () => { if (data instanceof Error) throw data; return data; });
  await f.sample(); data = new Error('secret path contents'); assertUnavailable(await f.sample(), 'read-failed');
  data = 'private contents'; const invalid = await f.sample(); assertUnavailable(invalid, 'invalid-meminfo'); assert.ok(!JSON.stringify(invalid).includes('private'));
  data = info(); assert.equal((await f.sample()).status, 'available');
  for (const clock of [() => NaN, () => Infinity, () => -1, () => 0.5, () => 8640000000000001, () => { throw new Error('secret clock'); }]) assertUnavailable(await sampler(async () => info(), clock).sample(), 'clock-unavailable');
  assert.equal((await sampler(async () => info(), () => 0).sample()).sampledAt, '1970-01-01T00:00:00.000Z');
  let now = time; const regressed = sampler(async () => info(), () => now); await regressed.sample(); now -= 100000;
  const earlier = await regressed.sample(); assert.equal(earlier.status, 'available'); assert.equal(earlier.sampledAt, new Date(now).toISOString()); assert.equal(earlier.usedBytes, 61440);
  let resolve; const f2 = sampler(() => new Promise(r => { resolve = r; })); const pending = f2.sample();
  await assert.rejects(f2.sample(), /already running/); resolve(info()); assert.equal((await pending).status, 'available');
});

test('fixed meminfo reader bounds segmented bytes, validates UTF-8 and closes after success or failure', { skip: process.platform !== 'linux' ? 'requires Linux fixed-reader guard' : false }, async () => {
  async function read(bytes, fail = false) {
    let offset = 0, closed = 0, readBytes = 0;
    const call = readProcMeminfo({ openFile: async (path, flags) => {
      assert.equal(path, '/proc/meminfo'); assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      return { read: async (buffer, position, length, filePosition) => {
        assert.equal(filePosition, null); if (fail) throw new Error('private read');
        const count = Math.min(257, bytes.length - offset, length); bytes.copy(buffer, position, offset, offset + count); offset += count; readBytes += count; return { bytesRead: count };
      }, close: async () => { closed++; } };
    } });
    try { return { text: await call, readBytes }; } finally { assert.equal(closed, 1); assert.ok(readBytes <= 65537); }
  }
  assert.equal((await read(Buffer.from(info()))).text, info());
  const full = Buffer.from(info() + 'x'.repeat(65536 - Buffer.byteLength(info()))); assert.equal((await read(full)).readBytes, 65536);
  for (const data of [Buffer.alloc(0), Buffer.concat([full, Buffer.from('x')]), Buffer.alloc(131072, 120), Buffer.from([0xff])]) await assert.rejects(read(data));
  await assert.rejects(read(Buffer.from(info()), true));
  await assert.rejects(readProcMeminfo({ openFile: async () => { throw new Error('private open'); } }));
});

test('shared memory loop preserves CPU alias and 30s serial cadence even when unavailable; stop discards a late gauge', async () => {
  assert.equal(runCpuLoop, runSamplingLoop); assert.equal(COLLECTION_INTERVAL_MS, CPU_INTERVAL_MS); assert.equal(COLLECTION_INTERVAL_MS, 30000);
  const stop = new AbortController(), waits = [], samples = []; let active = 0;
  await runSamplingLoop({ signal: stop.signal, sampler: { sample: async () => { assert.equal(++active, 1); await Promise.resolve(); active--; return { status: 'unavailable' }; } },
    onSample: sample => samples.push(sample), wait: async ms => { waits.push(ms); if (waits.length === 2) stop.abort(); } });
  assert.deepEqual(waits, [30000, 30000]); assert.equal(samples.length, 2);
  const drain = new AbortController(); let finish, outputs = 0;
  const pending = runSamplingLoop({ signal: drain.signal, sampler: { sample: () => new Promise(r => { finish = r; }) }, onSample: () => outputs++ });
  drain.abort(); finish({ status: 'available' }); await pending; assert.equal(outputs, 0);
});
