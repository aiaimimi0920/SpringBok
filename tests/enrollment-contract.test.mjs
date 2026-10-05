import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { joinChallengeDigest, enrollmentStart, preparedEnrollment, nodeEnrollment, catalogEnrollment, joinInput, enrollmentReceipt, enrollmentFinalId } from '../cloud/enrollment-contract.mjs';
import { enrollmentGrant } from '../src/node-enrollment/client.mjs';
const context = { ownerId: 'a'.repeat(64), nodeId: randomUUID() };
const id = randomUUID(), secret = randomBytes(32).toString('hex');

test('one-time join challenge is independent, context-bound and exact-schema only', async () => {
  const digest = await joinChallengeDigest(context, id, secret);
  assert.equal(digest.length, 64);
  for (const [scope, enrollment] of [[{ ...context, nodeId: randomUUID() }, id], [{ ...context, ownerId: 'b'.repeat(64) }, id], [context, randomUUID()]]) assert.notEqual(await joinChallengeDigest(scope, enrollment, secret), digest);
  const input = { id, revision: 0, serverId: context.nodeId, challengeDigest: digest };
  assert.deepEqual(enrollmentStart(input), input);
  for (const extra of [{ ownerId: context.ownerId }, { challenge: secret }, { action: 'deploy' }, { revision: -1 }, { serverId: 'pc2-test' }]) assert.throws(() => enrollmentStart({ ...input, ...extra }));
  const grant = { protocolVersion: 2, origin: 'https://control.example.invalid', ...context, enrollmentId: id, challenge: secret };
  assert.deepEqual(enrollmentGrant(grant), grant);
  for (const extra of [{ origin: 'http://control.example.invalid' }, { origin: 'https://user:password@control.example.invalid' }, { ownerId: 'client-owner' }, { protocolVersion: 1 }, { nodeId: 'pc2-test' }, { executeToken: secret }]) assert.throws(() => enrollmentGrant({ ...grant, ...extra }));
});

test('prepared/joined records strictly preserve the ten-minute bound and separate role fingerprints', () => {
  const prepared = { enrollmentId: id, challengeDigest: '1'.repeat(64), createdAt: 1000, expiresAt: 601000 };
  assert.deepEqual(preparedEnrollment(prepared), prepared);
  assert.throws(() => preparedEnrollment({ ...prepared, expiresAt: 601001 }));
  const input = { protocolVersion: 2, enrollmentId: id, requestId: randomUUID(), executeDigest: '2'.repeat(64), observeDigest: '3'.repeat(64) };
  assert.deepEqual(joinInput(input), input);
  assert.throws(() => joinInput({ ...input, observeDigest: input.executeDigest }));
  assert.throws(() => joinInput({ ...input, ownerId: context.ownerId }));
  const joined = { ...prepared, status: 'joined', input, joinedAt: 2000 };
  assert.deepEqual(nodeEnrollment(joined), joined);
  assert.throws(() => nodeEnrollment({ ...joined, joinedAt: prepared.expiresAt }));
  assert.throws(() => nodeEnrollment({ ...joined, input: { ...input, enrollmentId: randomUUID() } }));
  const active = { ...prepared, serverId: context.nodeId, state: 'active', updatedAt: 3000, joinRequestId: input.requestId, joinedAt: 2000 };
  assert.deepEqual(catalogEnrollment(active), active);
  assert.throws(() => catalogEnrollment({ ...active, updatedAt: 1500 }));
});

test('enrollment receipts share revision/capacity without reusing user request IDs for finalization', () => {
  const prepare = { id, revision: 5, serverId: context.nodeId, challengeDigest: '1'.repeat(64) };
  const enrolling = { serverId: context.nodeId, enrollmentId: id, challengeDigest: prepare.challengeDigest, createdAt: 1000, expiresAt: 601000, updatedAt: 1000, state: 'enrolling' };
  const entry = { request_id: id, input_json: JSON.stringify({ resource: 'enrollment', action: 'prepare', ...prepare }), result_json: JSON.stringify({ id, revision: 6, enrollment: enrolling }) };
  assert.equal(enrollmentReceipt(entry, 6).revision, 6);
  assert.throws(() => enrollmentReceipt({ ...entry, result_json: '{}' }, 6));
  const final = { serverId: context.nodeId, enrollmentId: id, joinRequestId: randomUUID(), joinedAt: 2000 }, key = enrollmentFinalId(id);
  assert.notEqual(key, id);
  const result = { id: key, revision: 7, enrollment: { ...enrolling, state: 'active', updatedAt: 3000, joinRequestId: final.joinRequestId, joinedAt: final.joinedAt } };
  assert.deepEqual(enrollmentReceipt({ request_id: key, input_json: JSON.stringify({ resource: 'enrollment', action: 'finalize', ...final }), result_json: JSON.stringify(result) }, 7), result);
});
