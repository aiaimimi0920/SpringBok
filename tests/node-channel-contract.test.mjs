import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { probePlan } from '../cloud/node-protocol.mjs';
import { channelInput, channelResult, verifyChannelResult } from '../cloud/node-channel-contract.mjs';

const credential = { ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID(), role: 'execute' };
const context = { ownerId: credential.ownerId, nodeId: credential.nodeId };
test('channel inputs preserve strict probe-only polling and reporting rather than generic dispatch', () => {
  assert.deepEqual(channelInput('poll', { protocolVersion: 2 }), { protocolVersion: 2 });
  for (const operation of ['deploy', 'approve', 'metrics', 'fixture-cycle']) assert.throws(() => channelInput(operation, { protocolVersion: 2 }));
  for (const extra of [{ protocolVersion: 1 }, { ownerId: credential.ownerId }, { role: 'execute' }, { operation: 'deploy' }]) assert.throws(() => channelInput('poll', { protocolVersion: 2, ...extra }));
});
test('delivery envelopes bind owner, node, enrollment, execute role and complete probe scope', async () => {
  const input = await probePlan(context, { requestId: randomUUID(), revision: 0, challenge: 'b'.repeat(64) });
  const value = channelResult(context, credential.enrollmentId, { status: 'delivery', input });
  assert.deepEqual(verifyChannelResult(value, credential, 'poll'), { status: 'delivery', input });
  for (const extra of [{ ownerId: 'c'.repeat(64) }, { nodeId: randomUUID() }, { enrollmentId: randomUUID() }, { role: 'observe' }, { executionReady: true }, { actor: 'human' }]) assert.throws(() => verifyChannelResult({ ...value, ...extra }, credential, 'poll'));
  for (const extra of [{ operation: 'deploy' }, { serviceId: 'gateway' }, { environment: 'production' }, { protocolVersion: 1 }, { nodeId: randomUUID() }]) assert.throws(() => verifyChannelResult({ ...value, result: { status: 'delivery', input: { ...input, ...extra } } }, credential, 'poll'));
});
test('receipt acknowledgment distinguishes observed from permanent cloud unknown and rejects wrong or expanded results', () => {
  const receipt = { protocolVersion: 2, requestId: randomUUID(), planDigest: `sha256:${'d'.repeat(64)}`, challenge: 'e'.repeat(64), outcome: 'observed' };
  assert.deepEqual(channelInput('report', receipt), receipt);
  for (const status of ['observed', 'unknown']) assert.equal(verifyChannelResult(channelResult(context, credential.enrollmentId, { status, requestId: receipt.requestId }), credential, 'report', receipt).status, status);
  for (const result of [{ status: 'observed', requestId: randomUUID() }, { status: 'queued', requestId: receipt.requestId }, { status: 'observed', requestId: receipt.requestId, success: true }]) assert.throws(() => verifyChannelResult(channelResult(context, credential.enrollmentId, result), credential, 'report', receipt));
  assert.throws(() => verifyChannelResult(channelResult(context, credential.enrollmentId, { status: 'observed', requestId: receipt.requestId }), credential, 'report', { ...receipt, outcome: 'unknown' }));
});
