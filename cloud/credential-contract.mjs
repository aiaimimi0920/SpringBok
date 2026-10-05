import { exact } from './protocol.mjs';
import { nodeContext } from './node-protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { isDigest } from './enrollment-contract.mjs';

export const NODE_ROLES = Object.freeze(['execute', 'observe']);
export function requireCredential(condition) { if (!condition) throw new Error('node credential rejected or unconfirmed'); }
export function nodeRole(value) { requireCredential(NODE_ROLES.includes(value)); return value; }
export function identityRequest(value) {
  exact(value, ['protocolVersion']); requireCredential(value.protocolVersion === 2); return { protocolVersion: 2 };
}
export function pinnedOrigin(value) {
  requireCredential(typeof value === 'string'); const url = new URL(value);
  requireCredential(url.protocol === 'https:' && url.origin === value && !url.username && !url.password); return value;
}
export function nodeCredential(value, expectedOrigin) {
  exact(value, ['protocolVersion', 'origin', 'ownerId', 'nodeId', 'enrollmentId', 'role', 'token']);
  requireCredential(value.protocolVersion === 2 && value.origin === pinnedOrigin(expectedOrigin) && isUuid(value.enrollmentId) && isDigest(value.token));
  return { protocolVersion: 2, origin: expectedOrigin, ...nodeContext({ ownerId: value.ownerId, nodeId: value.nodeId }), enrollmentId: value.enrollmentId, role: nodeRole(value.role), token: value.token };
}
export async function credentialDigest(token) {
  requireCredential(isDigest(token)); const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function identityResult(context, enrollmentId, role) {
  requireCredential(isUuid(enrollmentId));
  return { protocolVersion: 2, ...nodeContext(context), enrollmentId, role: nodeRole(role), status: 'authenticated', capabilities: ['identity:self'], executionReady: false };
}
export function verifyIdentity(value, credential) {
  exact(value, ['protocolVersion', 'ownerId', 'nodeId', 'enrollmentId', 'role', 'status', 'capabilities', 'executionReady']);
  const expected = identityResult({ ownerId: credential.ownerId, nodeId: credential.nodeId }, credential.enrollmentId, credential.role);
  requireCredential(Object.entries(expected).every(([key, field]) => key === 'capabilities' ? Array.isArray(value[key]) && value[key].length === 1 && value[key][0] === field[0] : value[key] === field));
  return expected;
}
