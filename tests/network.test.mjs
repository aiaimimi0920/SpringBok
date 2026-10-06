import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { parseNetworkDev, createNetworkSampler, readNetworkCounters } from '../src/node-telemetry/network.mjs';
import { runSamplingLoop } from '../src/node-telemetry/loop.mjs';

const header = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
const dev = (rows = [['lo', 10n, 20n]]) => header + rows.map(([name, rx, tx]) => ` ${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`).join('');
const bootId = '12345678-1234-1234-1234-123456789abc\n', namespace = 'net:[123456]';
function harness() {
  const state = { text: dev(), bootId, namespace, now: 0n, time: 1791248400000 };
  const sampler = createNetworkSampler({ readCounters: async () => { if (state.error) throw state.error; return state; }, monotonic: () => state.now, wallClock: () => state.time });
  return { state, sampler, tick(ms = 30000) { state.now += BigInt(ms) * 1000000n; state.time += ms; } };
}
const assertNull = row => { for (const key of ['rxBytes', 'txBytes', 'rxBytesPerSecond', 'txBytesPerSecond']) assert.equal(row[key], null); };

test('network parses strict uint64 counters, preserves precision and rejects malformed/duplicate interfaces and headers', () => {
  assert.deepEqual(parseNetworkDev(dev()).get('lo'), { rx: 10n, tx: 20n });
  assert.equal(parseNetworkDev(dev([['eth0', 18446744073709551615n, 0n]])).get('eth0').rx, 18446744073709551615n);
  for (const text of ['', dev().replace('Transmit', 'Other'), dev().replace('carrier', 'changed'), dev([['lo', 0, 0], ['lo', 1, 1]]),
    ...['-1', '01', '1.2', '1e3', 'NaN', '18446744073709551616'].map(rx => dev([['lo', rx, 0]])),
    ...['.', '..', 'too-long-interface', 'bad/name', 'bad:name', '注', 'bad name'].map(name => dev([[name, 0, 0]])),
    dev().trimEnd() + ' 0\n', dev().replace(' 20 ', ' private '), dev().replace(' 0\n', '\n'), dev().replace(' 0\n', ' 18446744073709551616\n'),
    dev(Array.from({ length: 257 }, (_, i) => [`eth${i}`, 0, 0])), dev() + 'x'.repeat(65536), null]) assert.throws(() => parseNetworkDev(text));
  assert.equal(parseNetworkDev(header).size, 0);
  assert.equal(parseNetworkDev(dev(Array.from({ length: 256 }, (_, i) => [`eth${i}`, 0, 0]))).size, 256);
  const padded = dev() + ' '.repeat(65536 - Buffer.byteLength(dev())); assert.equal(parseNetworkDev(padded).size, 1);
  assert.throws(() => parseNetworkDev(padded + '注'));
});

test('network starts unknown, reports exact per-interface deltas and two-decimal bytes/s over actual interval; zero is available', async () => {
  const h = harness(); h.state.text = dev([['lo', 9007199254740993n, 10], ['eth0', 10, 10]]);
  const first = await h.sampler.sample(); assert.equal(first.reason, 'warming-up'); assert.equal(first.intervalMs, null); first.interfaces.forEach(assertNull);
  h.tick(31000); h.state.text = dev([['eth0', 10, 10], ['lo', 9007199254740994n, 32010]]);
  const sample = await h.sampler.sample(); assert.equal(sample.status, 'available'); assert.equal(sample.reason, null); assert.equal(sample.intervalMs, 31000);
  assert.deepEqual(sample.interfaces, [{ name: 'eth0', status: 'available', reason: null, rxBytes: 0, txBytes: 0, rxBytesPerSecond: 0, txBytesPerSecond: 0 },
    { name: 'lo', status: 'available', reason: null, rxBytes: 1, txBytes: 32000, rxBytesPerSecond: 0.03, txBytesPerSecond: 1032.26 }]);
  assert.equal(sample.scope, 'linux-network-namespace'); assert.equal(sample.unit, 'bytes-per-second');
  assert.ok(!JSON.stringify(sample).includes('123456')); assert.equal(Object.hasOwn(sample, 'total'), false);
});

test('network early calls do not advance baseline; observed context/interface changes reset even before interval', async () => {
  const h = harness(); await h.sampler.sample(); h.tick(29999); h.state.text = dev([['lo', 310, 620]]);
  const early = await h.sampler.sample(); assert.equal(early.reason, 'interval-too-short'); early.interfaces.forEach(assertNull);
  h.tick(1); const sample = await h.sampler.sample(); assert.equal(sample.interfaces[0].rxBytes, 300); assert.equal(sample.intervalMs, 30000);
  for (const change of [() => { h.state.namespace = 'net:[999]'; }, () => { h.state.bootId = '87654321-1234-1234-1234-123456789abc\n'; }]) {
    change(); h.tick(1); assert.equal((await h.sampler.sample()).reason, 'context-changed'); h.tick(); assert.equal((await h.sampler.sample()).status, 'available');
  }
  h.state.text = dev([['eth0', 0, 0], ['lo', 310, 620]]); assert.equal((await h.sampler.sample()).reason, 'interface-set-changed');
  h.tick(); assert.equal((await h.sampler.sample()).status, 'available');
  h.state.text = dev([['eth1', 0, 0], ['lo', 310, 620]]); assert.equal((await h.sampler.sample()).reason, 'interface-set-changed');
  h.state.text = dev(); assert.equal((await h.sampler.sample()).reason, 'interface-set-changed');
});

test('network reset/wrap is unknown per interface, never wraps or clamps; unaffected interfaces remain independently available', async () => {
  const h = harness(); h.state.text = dev([['lo', 18446744073709551615n, 20], ['eth0', 10, 10]]); await h.sampler.sample();
  h.tick(); h.state.text = dev([['lo', 0, 20], ['eth0', 40, 70]]);
  const partial = await h.sampler.sample(); assert.equal(partial.status, 'partial'); assert.equal(partial.interfaces[0].rxBytesPerSecond, 1);
  assert.equal(partial.interfaces[1].reason, 'counter-regressed'); assertNull(partial.interfaces[1]);
  h.tick(); h.state.text = dev([['lo', 30, 50], ['eth0', 70, 100]]); assert.equal((await h.sampler.sample()).status, 'available');
  h.tick(); h.state.text = dev([['lo', 30, 0], ['eth0', 0, 100]]); assert.equal((await h.sampler.sample()).status, 'unknown');
});

test('network unsafe deltas/rates and invalid/read/clock failures do not expose stale values or private errors and rewarm', async () => {
  const h = harness(); await h.sampler.sample(); h.tick(); h.state.text = dev([['lo', 18446744073709551615n, 20]]);
  const overflow = await h.sampler.sample(); assert.equal(overflow.interfaces[0].reason, 'counter-out-of-range'); assertNull(overflow.interfaces[0]);
  for (const [key, value, reason] of [['error', new Error('private credential contents'), 'read-failed'], ['text', 'private contents', 'invalid-counters'], ['bootId', 'private', 'invalid-counters'], ['namespace', 'other:[123]', 'invalid-counters'], ['text', header, 'no-interfaces'], ['now', -1n, 'clock-unavailable'], ['now', 3, 'clock-unavailable'], ['time', NaN, 'clock-unavailable'], ['time', -1, 'clock-unavailable'], ['time', 0.5, 'clock-unavailable'], ['time', 8640000000000001, 'clock-unavailable']]) {
    const original = h.state[key]; h.state[key] = value; const bad = await h.sampler.sample(); assert.equal(bad.reason, reason);
    assert.equal(bad.sampledAt, null); assert.equal(bad.intervalMs, null); assert.deepEqual(bad.interfaces, []); assert.ok(!JSON.stringify(bad).includes('private'));
    h.state[key] = original; assert.equal((await h.sampler.sample()).reason, 'warming-up');
  }
  h.state.now = 0n; assert.equal((await h.sampler.sample()).reason, 'clock-regressed');
  h.tick(); h.state.time -= 60000; assert.equal((await h.sampler.sample()).reason, 'clock-regressed');
  h.state.now += BigInt(Number.MAX_SAFE_INTEGER) + 1n; assert.equal((await h.sampler.sample()).reason, 'interval-out-of-range');
});

test('network bounds scaled rates independently of safe byte deltas and rounds fractional nanosecond windows', async () => {
  const h = harness(); h.state.text = dev([['lo', 0, 0]]); await h.sampler.sample(); h.tick();
  h.state.text = dev([['lo', Number.MAX_SAFE_INTEGER, 0]]);
  const unsafe = await h.sampler.sample(); assert.equal(unsafe.interfaces[0].reason, 'counter-out-of-range'); assertNull(unsafe.interfaces[0]);
  const small = harness(); await small.sampler.sample(); small.tick(); small.state.now += 123456n;
  small.state.text = dev([['lo', 310, 21]]); const sample = await small.sampler.sample();
  assert.equal(sample.intervalMs, 30000.123456); assert.equal(sample.interfaces[0].rxBytesPerSecond, 10); assert.equal(sample.interfaces[0].txBytesPerSecond, 0.03);
});

test('network rejects concurrent sampling; shared serial loop preserves cadence and discards results after stop', async () => {
  let finish; const sampler = createNetworkSampler({ readCounters: () => new Promise(resolve => { finish = resolve; }) });
  const pending = sampler.sample(); await assert.rejects(sampler.sample(), /already running/);
  finish({ text: dev(), bootId, namespace }); assert.equal((await pending).reason, 'warming-up');
  const stop = new AbortController(), waits = []; let active = 0, outputs = 0;
  await runSamplingLoop({ sampler: { async sample() { assert.equal(++active, 1); await Promise.resolve(); active--; return {}; } }, signal: stop.signal,
    onSample: () => outputs++, wait: async ms => { waits.push(ms); if (outputs === 2) stop.abort(); } });
  assert.deepEqual(waits, [30000, 30000]); assert.equal(outputs, 2);
  const drain = new AbortController(); outputs = 0;
  const loop = runSamplingLoop({ sampler: { sample: () => new Promise(resolve => { finish = resolve; }) }, signal: drain.signal, onSample: () => outputs++ });
  drain.abort(); finish({}); await loop; assert.equal(outputs, 0);
});

test('fixed network reader bounds actual bytes, closes descriptors and rejects context changes without exposing markers', { skip: process.platform !== 'linux' ? 'requires Linux reader guard' : false }, async () => {
  async function read(bytes = Buffer.from(dev()), { namespaceChanged = false, bootChanged = false, fail = false } = {}) {
    let opened = 0, closed = 0, links = 0, bootReads = 0, devBytes = 0;
    try {
      return await readNetworkCounters({ readLink: async path => { assert.equal(path, '/proc/self/ns/net'); return namespaceChanged && links++ ? 'net:[999]' : namespace; },
        openFile: async (path, flags) => {
          assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); opened++;
          assert.ok(['/proc/self/net/dev', '/proc/sys/kernel/random/boot_id'].includes(path));
          const data = path.endsWith('/dev') ? bytes : Buffer.from(bootChanged && bootReads++ ? bootId.replace('12345678', '87654321') : bootId); let offset = 0;
          return { read: async (buffer, start, length, position) => {
            assert.equal(position, null); if (fail) throw new Error('private');
            const count = Math.min(length, 257, data.length - offset); data.copy(buffer, start, offset, offset + count); offset += count;
            if (path.endsWith('/dev')) devBytes += count; return { bytesRead: count };
          }, close: async () => { closed++; } };
        } });
    } finally { assert.equal(opened, closed); assert.ok(devBytes <= 65537); }
  }
  assert.deepEqual(await read(), { text: dev(), bootId, namespace });
  const full = Buffer.from(dev() + ' '.repeat(65536 - Buffer.byteLength(dev()))); assert.equal((await read(full)).text.length, 65536);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(65537, 32), Buffer.alloc(131072, 32), Buffer.from([0xff])]) await assert.rejects(read(bytes));
  for (const options of [{ namespaceChanged: true }, { bootChanged: true }, { fail: true }]) await assert.rejects(read(undefined, options));
  await assert.rejects(readNetworkCounters({ openFile: async () => { throw new Error('private open'); }, readLink: async () => namespace }));
});
