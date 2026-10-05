import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { nodeCredential, identityRequest, identityResult, verifyIdentity, credentialDigest, pinnedOrigin } from '../cloud/credential-contract.mjs';

const origin = 'https://control.example.invalid';
const credential = { protocolVersion: 2, origin, ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID(), role: 'execute', token: randomBytes(32).toString('hex') };
test('role material has an exact node binding, independent pinned HTTPS origin and no join or other-role secret', () => {
  assert.deepEqual(nodeCredential(credential, origin), credential);
  assert.deepEqual(nodeCredential({ ...credential, role: 'observe' }, origin), { ...credential, role: 'observe' });
  for (const extra of [{ role: 'admin' }, { protocolVersion: 1 }, { ownerId: 'client-owner' }, { nodeId: 'pc2-test' }, { token: 'x'.repeat(64) }, { challenge: credential.token }, { observeToken: credential.token }, { origin: 'https://attacker.example.invalid' }]) assert.throws(() => nodeCredential({ ...credential, ...extra }, origin));
  for (const value of [undefined, 'http://control.example.invalid', `${origin}/`, `${origin}?secret=1`, 'https://user:password@control.example.invalid']) assert.throws(() => pinnedOrigin(value));
  assert.throws(() => nodeCredential(credential, 'https://attacker.example.invalid'));
});
test('identity requests grant only self-inspection and reject caller-supplied authority or operations', () => {
  assert.deepEqual(identityRequest({ protocolVersion: 2 }), { protocolVersion: 2 });
  for (const extra of [{ protocolVersion: 1 }, { role: 'execute' }, { ownerId: credential.ownerId }, { operation: 'deploy' }, { actor: 'human' }, { approve: true }]) assert.throws(() => identityRequest({ protocolVersion: 2, ...extra }));
  const result = identityResult({ ownerId: credential.ownerId, nodeId: credential.nodeId }, credential.enrollmentId, credential.role);
  assert.deepEqual(verifyIdentity(result, credential), result); assert.equal(result.executionReady, false);
  for (const extra of [{ nodeId: randomUUID() }, { ownerId: 'b'.repeat(64) }, { enrollmentId: randomUUID() }, { role: 'observe' }, { status: 'joined' }, { executionReady: true }, { capabilities: ['identity:self', 'deploy'] }, { token: credential.token }]) assert.throws(() => verifyIdentity({ ...result, ...extra }, credential));
});
test('runtime role fingerprints preserve the N02 persisted SHA-256 token contract without low-entropy derivation', async () => {
  assert.equal(await credentialDigest(credential.token), createHash('sha256').update(credential.token).digest('hex'));
  assert.notEqual(await credentialDigest(randomBytes(32).toString('hex')), await credentialDigest(credential.token));
  await assert.rejects(credentialDigest('pc2-test')); await assert.rejects(credentialDigest('A'.repeat(64)));
});
