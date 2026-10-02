import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { transition, ledger } from '../cloud/protocol.mjs';
import { openJournal } from '../src/execution/journal.mjs';
import { createHash } from 'node:crypto';
import { openProbeBridge, nodeClient } from '../src/node-bridge/bridge.mjs';
const input = { id: 'probe-1', node: 'pc2-test', operation: 'protocol-probe', challenge: 'a'.repeat(64), revision: 0 };
const empty = () => ({ revision: 0, jobs: [] });
test('expired requests and lost claim responses never redeliver after restart or timeout', () => {
  const queued = transition(empty(), 'submit', input, 0).state;
  assert.equal(transition(queued, 'poll', { node: 'pc2-test' }, 120000).response.status, 'expired');
  const claimed = transition(queued, 'poll', { node: 'pc2-test' }, 1).state;
  assert.equal(transition(claimed, 'poll', { node: 'pc2-test' }, 2).response.status, 'claimed');
  const timedOut = transition(claimed, 'poll', { node: 'pc2-test' }, 120001);
  assert.equal(timedOut.response.status, 'unknown'); assert.equal(timedOut.response.input, undefined);
  assert.equal(transition(claimed, 'report', { id: input.id, challenge: input.challenge, outcome: 'observed' }, 120001).response.status, 'unknown');
  assert.throws(() => transition(timedOut.state, 'submit', { ...input, id: 'another', revision: timedOut.state.revision }, 120002));
});
test('canonical request identity, bounded history and strict schema survive malicious input', () => {
  const first = transition(empty(), 'submit', input, 1).state;
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(transition(first, 'submit', reordered, 2).changed, false);
  for (const bad of [{ ...input, id: ['probe-1'] }, { ...input, revision: -1 }, { ...input, operation: 'rollback' }, { ...input, command: 'anything' }]) assert.throws(() => transition(empty(), 'submit', bad, 0));
  assert.throws(() => ledger({ 'jobs,revision': [] }));
  const full = { revision: 100, jobs: Array.from({ length: 100 }, (_, i) => ({ input: { ...input, id: `p-${i}` }, status: 'observed', expiresAt: 120000 })) };
  assert.throws(() => transition(full, 'submit', { ...input, revision: 100 }, 2));
});
test('a durable started marker recovers to unknown without local observation, with no credentials persisted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-bridge-')), origin = 'https://control.example.invalid';
  const token = randomBytes(32).toString('hex'); let bridge;
  try {
    const binding = createHash('sha256').update(`protocol-probe/v1/pc2-test/${origin}`).digest('hex');
    const j = openJournal(directory, binding, () => {}); j.append({ kind: 'started', input }); j.close();
    let observed = 0;
    bridge = openProbeBridge({ directory, origin, token, observe: async () => { observed++; }, fetcher: async (url, init) => {
      assert.ok(url.endsWith('/node/report')); const receipt = JSON.parse(init.body); assert.equal(receipt.outcome, 'unknown');
      return Response.json({ status: 'unknown', id: receipt.id });
    } });
    assert.equal(await bridge.step(), 'unknown'); assert.equal(observed, 0);
    assert.equal(readFileSync(join(directory, 'ledger.json'), 'utf8').includes(token), false);
    assert.throws(() => openProbeBridge({ directory, origin, token }));
  } finally { bridge?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('bridge refuses unexpected destinations, redirects, malformed responses and duplicate local dispatch', async () => {
  assert.throws(() => nodeClient('http://control.example.invalid', 'a'.repeat(64)));
  assert.throws(() => nodeClient('https://user:pass@control.example.invalid', 'a'.repeat(64)));
  const directory = mkdtempSync(join(tmpdir(), 'springbok-bridge-')); let calls = 0, bridge;
  try {
    bridge = openProbeBridge({ directory, origin: 'https://control.example.invalid', token: 'a'.repeat(64), fetcher: async (url, init) => {
      assert.equal(init.redirect, 'error'); calls++;
      if (url.endsWith('/node/report')) return Response.json({ status: 'observed', id: input.id });
      return Response.json({ status: 'delivery', input });
    } });
    assert.equal(await bridge.step(), 'observed'); await assert.rejects(bridge.step()); assert.equal(calls, 3);
  } finally { bridge?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lost timeout acknowledgement settles unknown after bridge restart without another observation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-late-ack-'));
  let state = transition(empty(), 'submit', input, 0).state, now = 1, observations = 0, lost = true, bridge;
  const fetcher = async (url, init) => {
    const value = JSON.parse(init.body), operation = url.endsWith('/node/poll') ? 'poll' : 'report';
    const result = transition(state, operation, value, now); state = result.state;
    if (operation === 'report' && lost) { lost = false; assert.equal(result.response.status, 'unknown'); throw new Error('lost late ack'); }
    return Response.json(result.response);
  };
  const options = { directory, origin: 'https://control.example.invalid', token: 'b'.repeat(64), fetcher,
    observe: async () => { observations++; now = 120001; } };
  try {
    bridge = openProbeBridge(options); await assert.rejects(bridge.step()); bridge.close();
    assert.equal(state.jobs[0].status, 'unknown'); const revision = state.revision;
    bridge = openProbeBridge(options); assert.equal(await bridge.step(), 'unknown');
    assert.equal(bridge.snapshot().at(-1).kind, 'ack'); assert.equal(bridge.snapshot().at(-1).status, 'unknown');
    assert.equal(await bridge.step(), 'unknown'); assert.equal(observations, 1); assert.equal(state.revision, revision);
    for (let i = 0; i < 3; i++) assert.equal(transition(state, 'report', { id: input.id, challenge: input.challenge, outcome: 'observed' }, now).response.status, 'unknown');
    assert.throws(() => transition(state, 'submit', { ...input, id: 'another', revision }, now));
  } finally { bridge?.close(); rmSync(directory, { recursive: true, force: true }); }
});
