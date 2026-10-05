import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { heartbeatTransition as transition, heartbeatSnapshot, heartbeatState, heartbeatInput, heartbeatResult, HEARTBEAT_INTERVAL_MS } from '../cloud/heartbeat-contract.mjs';
import { openHeartbeatClient } from '../src/node-heartbeat/client.mjs';
import { RetryableNodeError } from '../src/node-credentials/client.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';

const context = { ownerId: 'a'.repeat(64), nodeId: randomUUID() };
const empty = () => ({ execute: null, observe: null });
const start = (bootId, previousGeneration) => ({ protocolVersion: 2, bootId, previousGeneration });
const sample = (bootId, generation, sequence, sampledAt = 0) => ({ protocolVersion: 2, bootId, generation, sequence, sampledAt });
test('heartbeat thresholds use cloud received time, distinguish unknown and preserve future client sampling without trusting it', () => {
  const boot = randomUUID(); let state = transition(empty(), 'execute', 'start', start(boot, 0), 1000).state;
  assert.equal(heartbeatSnapshot(context, state, 1000, true).roles.execute.status, 'unknown');
  state = transition(state, 'execute', 'sample', sample(boot, 1, 1, 8640000000000000), 1000).state;
  for (const [now, expected] of [[1000, 'online'], [90999, 'online'], [91000, 'stale'], [300999, 'stale'], [301000, 'offline'], [999, 'unknown']]) {
    const result = heartbeatSnapshot(context, state, now, true);
    assert.equal(result.roles.execute.status, expected); assert.equal(result.roles.observe.status, 'unknown'); assert.equal(result.executionReady, false);
  }
  assert.equal(heartbeatSnapshot(context, state, 1000, false).roles.execute.status, 'unknown');
});
test('session CAS, sequence and exact replay prevent late boots, out-of-order samples and refresh-by-replay with bounded storage', () => {
  const a = randomUUID(), b = randomUUID(); let state = transition(empty(), 'execute', 'start', start(a, 0), 1000).state;
  const input = sample(a, 1, 2, 1000), first = transition(state, 'execute', 'sample', input, 1000); state = first.state;
  assert.deepEqual(transition(state, 'execute', 'sample', input, 500000).result, first.result);
  assert.equal(transition(state, 'execute', 'sample', sample(a, 1, 3), 30999).result.status, 'deferred');
  assert.throws(() => transition(state, 'execute', 'sample', sample(a, 1, 1), 500000));
  assert.throws(() => transition(state, 'execute', 'sample', { ...input, sampledAt: 1 }, 500000));
  state = transition(state, 'execute', 'start', start(b, 1), 40000).state;
  assert.equal(state.execute.latest.bootId, a); // start 不刷新在线/接收时间。
  assert.throws(() => transition(state, 'execute', 'sample', input, 500000));
  assert.throws(() => transition(state, 'execute', 'start', start(a, 0), 500000));
  assert.throws(() => transition(state, 'execute', 'start', start(randomUUID(), 1), 500000));
  assert.equal(transition(state, 'execute', 'start', start(b, 1), 500000).changed, false);
  state = transition(state, 'execute', 'sample', sample(b, 2, 1), 40000).state;
  assert.equal(state.execute.latest.bootId, b); assert.equal(Object.keys(state).length, 2);
  assert.throws(() => transition(state, 'execute', 'sample', sample(b, 2, 2), 39999));
  assert.equal(HEARTBEAT_INTERVAL_MS, 30000);
});
test('heartbeat contract strictly rejects extra authority, invalid bounds, damaged metadata and samples', () => {
  for (const input of [{ protocolVersion: 1 }, { protocolVersion: 2, role: 'execute' }, null]) assert.throws(() => heartbeatInput('read', input));
  for (const sequence of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => heartbeatInput('sample', sample(randomUUID(), 1, sequence)));
  assert.throws(() => heartbeatInput('start', start(randomUUID(), Number.MAX_SAFE_INTEGER)));
  for (const value of [{}, { ...empty(), token: 'unexpected' }, { execute: {}, observe: null }]) assert.throws(() => heartbeatState(value));
  const boot = randomUUID(), state = transition(empty(), 'execute', 'start', start(boot, 0), 1000).state;
  assert.throws(() => heartbeatState({ ...state, execute: { ...state.execute, latest: { ...sample(boot, 2, 1), receivedAt: 1000 } } }));
});
test('role client recovers lost start/sample replies with identical input, honors stop boundaries and rejects wrong-scope replies', async () => {
  const f = packageFixture(), r = roleFixture(f.directory, 'observe'), requests = []; let state = empty(), lostStart = true, lostSample = true;
  try {
    const fetcher = async (url, init) => {
      const operation = new URL(url).pathname.split('/').at(-1), input = JSON.parse(init.body);
      requests.push({ operation, input }); assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, `Bearer ${r.credential.token}`);
      const result = transition(state, 'observe', operation, input, 1000); state = result.state;
      if (operation === 'start' && lostStart) { lostStart = false; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' }); }
      if (operation === 'sample' && lostSample) { lostSample = false; throw Object.assign(new Error('lost'), { code: 'ECONNRESET' }); }
      return Response.json(heartbeatResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId }, r.credential.enrollmentId, 'observe', result.result));
    };
    const c = openHeartbeatClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, now: () => 500000, fetcher }), stop = new AbortController();
    await assert.rejects(c.beat(stop.signal), RetryableNodeError); await assert.rejects(c.beat(stop.signal), RetryableNodeError);
    assert.equal(await c.beat(stop.signal), 'recorded');
    assert.deepEqual(requests.filter(r => r.operation === 'start').map(r => r.input)[0], requests.filter(r => r.operation === 'start').map(r => r.input)[1]);
    assert.deepEqual(requests.filter(r => r.operation === 'sample').map(r => r.input)[0], requests.filter(r => r.operation === 'sample').map(r => r.input)[1]);
    assert.equal(state.observe.latest.receivedAt, 1000); stop.abort(); const count = requests.length; await c.beat(stop.signal); assert.equal(requests.length, count);
    const wrong = openHeartbeatClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, fetcher: () => Response.json(heartbeatResult(context, r.credential.enrollmentId, 'execute', { generation: 0 })) });
    await assert.rejects(wrong.beat(new AbortController().signal));
    const draining = new AbortController(); let calls = 0;
    const d = openHeartbeatClient({ file: r.credentialFile, expectedOrigin: r.credential.origin, fetcher: () => { calls++; draining.abort(); return Response.json(heartbeatResult({ ownerId: r.credential.ownerId, nodeId: r.credential.nodeId }, r.credential.enrollmentId, 'observe', { generation: 0 })); } });
    await d.beat(draining.signal); assert.equal(calls, 1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
