import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { origin } from './admin-fixture.mjs';
import { joinChallengeDigest } from '../../cloud/enrollment-contract.mjs';
import { credentialDigest } from '../../cloud/credential-contract.mjs';

export const heartbeatFlags = { ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_NODE_CREDENTIALS: 'yes', ENABLE_NODE_CHANNEL: 'yes', ENABLE_NODE_HEARTBEAT: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' };
export const heartbeatOptions = { entryPoint: 'tests/cloud/enrollment-fixture.mjs' };
export async function heartbeatNode(f, claims = {}, join = true) {
  const token = f.jwt(claims), session = (await f.call('/api/admin/state', { token })).json(), headers = { 'x-csrf-token': session.csrf };
  const revision = (await f.call('/api/admin/servers', { token })).json().revision;
  const created = await f.call('/api/admin/servers', { token, headers, body: { id: randomUUID(), revision, action: 'create', name: '心跳验收节点' } }); assert.equal(created.status, 200, created.text);
  const context = { ownerId: session.ownerId, nodeId: created.json().server.id }, enrollmentId = randomUUID(), challenge = randomBytes(32).toString('hex');
  const prepared = await f.call('/api/admin/enrollments', { token, headers, body: { id: enrollmentId, revision: revision + 1, serverId: context.nodeId, challengeDigest: await joinChallengeDigest(context, enrollmentId, challenge) } }); assert.equal(prepared.status, 200, prepared.text);
  const roles = Object.fromEntries(['execute', 'observe'].map(role => [role, { protocolVersion: 2, origin, ...context, enrollmentId, role, token: randomBytes(32).toString('hex') }]));
  if (join) {
    const joined = await f.call(`/node/v2/join/${context.ownerId}/${context.nodeId}`, { token: null, headers: { authorization: `Bearer ${challenge}` }, body: { protocolVersion: 2, enrollmentId, requestId: randomUUID(), executeDigest: await credentialDigest(roles.execute.token), observeDigest: await credentialDigest(roles.observe.token) } });
    assert.ok([200, 202].includes(joined.status), joined.text);
  }
  return { context, roles, token, headers, challenge, path: `/api/admin/nodes/${context.nodeId}/heartbeat` };
}
export async function heartbeatCall(f, c, operation, body, expected = 200, extra = {}) {
  const path = `/node/v2/heartbeat/${c.role}/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/${operation}`;
  const response = await f.call(extra.path ?? path, { token: null, headers: { authorization: `Bearer ${c.token}`, ...extra.headers }, body, ...(extra.method ? { method: extra.method } : {}) });
  assert.equal(response.status, expected, response.text); return response.json();
}
export async function heartbeatSample(f, c, sampledAt = Date.now()) {
  const read = await heartbeatCall(f, c, 'read', { protocolVersion: 2 }), bootId = randomUUID();
  const started = await heartbeatCall(f, c, 'start', { protocolVersion: 2, bootId, previousGeneration: read.result.generation });
  const input = { protocolVersion: 2, bootId, generation: started.result.generation, sequence: 1, sampledAt };
  const response = await heartbeatCall(f, c, 'sample', input); return { input, response };
}
export async function heartbeatRpc(f, context, operation, args = [], expected = 200) {
  const response = await f.call('/__enrollment_fixture', { body: { resource: 'node', context: { ownerId: context.ownerId, nodeId: context.nodeId }, operation, args } });
  assert.equal(response.status, expected, response.text); return expected === 200 ? response.json() : null;
}
