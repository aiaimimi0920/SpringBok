import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_POLL_MS, MAX_BACKOFF_MS, pollDelay, runNodeLoop } from '../src/node-daemon/loop.mjs';
import { RetryableNodeError, fetchCredentialJson } from '../src/node-credentials/client.mjs';

test('daemon delay has a fixed floor, capped exponential backoff and positive bounded jitter', () => {
  assert.equal(MIN_POLL_MS, 30000); assert.equal(MAX_BACKOFF_MS, 300000);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(n => pollDelay(n, () => 0)), [30000, 30000, 60000, 120000, 240000, 300000, 300000]);
  for (const count of [0, 1, 2, 3, 4, 5, 999]) for (const sample of [0, 0.5, 0.999999]) { const ms = pollDelay(count, () => sample); assert.ok(ms >= 30000 && ms <= 300000); }
  for (const sample of [-1, 1, NaN, Infinity]) assert.throws(() => pollDelay(0, () => sample));
  for (const count of [-1, 0.1, Infinity]) assert.throws(() => pollDelay(count));
});

test('transport retries are explicit while TLS, redirects, protocol and unclassified exceptions are fatal', async () => {
  for (const status of [429, 500, 502, 503, 504]) await assert.rejects(fetchCredentialJson(() => Response.json({}, { status })), RetryableNodeError);
  for (const status of [204, 307, 400, 401, 403, 404, 409]) await assert.rejects(fetchCredentialJson(() => new Response(null, { status })), error => !(error instanceof RetryableNodeError));
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'UND_ERR_SOCKET']) await assert.rejects(fetchCredentialJson(() => { throw new TypeError('secret upstream error', { cause: { code } }); }), RetryableNodeError);
  await assert.rejects(fetchCredentialJson(() => { throw new DOMException('timeout', 'TimeoutError'); }), RetryableNodeError);
  for (const error of [new Error('unknown'), new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }), new TypeError('redirect failed')]) await assert.rejects(fetchCredentialJson(() => { throw error; }), value => value === error);
  await assert.rejects(fetchCredentialJson(() => new Response('{')), error => !(error instanceof RetryableNodeError));
  await assert.rejects(fetchCredentialJson(() => new Response('x'.repeat(4097))), error => !(error instanceof RetryableNodeError));
  const broken = new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); } });
  await assert.rejects(fetchCredentialJson(() => new Response(broken)), RetryableNodeError);
});

test('loop serializes steps, caps failures, resets backoff on recovery and emits only status transitions', async () => {
  const stop = new AbortController(), delays = [], events = []; let calls = 0, active = 0;
  const result = await runNodeLoop({ signal: stop.signal, random: () => 0, onEvent: value => events.push(value),
    step: async () => { assert.equal(++active, 1); await Promise.resolve(); active--; calls++; if (calls <= 7) throw new RetryableNodeError(); return calls === 8 ? 'observed' : 'idle'; },
    wait: async ms => { delays.push(ms); if (delays.length === 10) stop.abort(); },
  });
  assert.equal(result, 'stopped'); assert.equal(calls, 10);
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 300000, 300000, 300000, 30000, 30000, 30000]);
  assert.deepEqual(events.map(e => e.status), ['retrying', 'observed', 'idle']); assert.ok(events.every(e => e.executionReady === false));
});

test('stop drains one in-flight step and interrupts the real timer without beginning new work', async () => {
  const stop = new AbortController(); let finish, calls = 0, waited = false;
  const result = runNodeLoop({ signal: stop.signal, step: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, wait: async () => { waited = true; } });
  stop.abort(); finish('observed'); assert.equal(await result, 'stopped'); assert.equal(calls, 1); assert.equal(waited, false);
  const asleep = new AbortController(); let sleptCalls = 0;
  const sleeping = runNodeLoop({ signal: asleep.signal, step: async () => { sleptCalls++; return 'idle'; } });
  await new Promise(resolve => setImmediate(resolve)); asleep.abort(); assert.equal(await sleeping, 'stopped'); assert.equal(sleptCalls, 1);
  assert.equal(await runNodeLoop({ signal: asleep.signal, step: () => { throw new Error('must not run'); } }), 'stopped');
});

test('unknown, invalid statuses and local persistence failures cannot enter retry or another poll', async () => {
  let waits = 0, calls = 0;
  assert.equal(await runNodeLoop({ signal: new AbortController().signal, step: async () => { calls++; return 'unknown'; }, wait: async () => { waits++; } }), 'blocked');
  assert.equal(calls, 1); assert.equal(waits, 0);
  for (const step of [async () => 'deployment-ready', async () => { throw new Error('journal write uncertain'); }]) await assert.rejects(runNodeLoop({ signal: new AbortController().signal, step, wait: async () => { waits++; } }));
  assert.equal(waits, 0);
});
