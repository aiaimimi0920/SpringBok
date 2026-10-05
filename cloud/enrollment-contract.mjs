import { exact } from './protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { nodeContext } from './node-protocol.mjs';

export const ENROLLMENT_TTL_MS = 600000;
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function requireEnrollment(condition) { if (!condition) throw new Error('enrollment rejected or uncertain'); }
export async function joinChallengeDigest(context, enrollmentId, challenge) {
  nodeContext(context); requireEnrollment(isUuid(enrollmentId) && isDigest(challenge));
  const value = JSON.stringify(['springbok-join/v2', context.ownerId, context.nodeId, enrollmentId, challenge]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function enrollmentStart(value) {
  exact(value, ['id', 'revision', 'serverId', 'challengeDigest']);
  requireEnrollment(isUuid(value.id) && integer(value.revision) && isUuid(value.serverId) && isDigest(value.challengeDigest));
  return { id: value.id, revision: value.revision, serverId: value.serverId, challengeDigest: value.challengeDigest };
}
export function enrollmentTarget(value) {
  exact(value, ['serverId', 'enrollmentId']); requireEnrollment(isUuid(value.serverId) && isUuid(value.enrollmentId));
  return { serverId: value.serverId, enrollmentId: value.enrollmentId };
}
export function preparedEnrollment(value) {
  exact(value, ['enrollmentId', 'challengeDigest', 'createdAt', 'expiresAt']);
  requireEnrollment(isUuid(value.enrollmentId) && isDigest(value.challengeDigest) && integer(value.createdAt) && integer(value.expiresAt) && value.expiresAt === value.createdAt + ENROLLMENT_TTL_MS);
  return { enrollmentId: value.enrollmentId, challengeDigest: value.challengeDigest, createdAt: value.createdAt, expiresAt: value.expiresAt };
}
export function joinInput(value) {
  exact(value, ['protocolVersion', 'enrollmentId', 'requestId', 'executeDigest', 'observeDigest']);
  requireEnrollment(value.protocolVersion === 2 && isUuid(value.enrollmentId) && isUuid(value.requestId) && isDigest(value.executeDigest) && isDigest(value.observeDigest) && value.executeDigest !== value.observeDigest);
  return { protocolVersion: 2, enrollmentId: value.enrollmentId, requestId: value.requestId, executeDigest: value.executeDigest, observeDigest: value.observeDigest };
}
export function nodeEnrollment(value) {
  const joined = value?.status === 'joined';
  exact(value, ['enrollmentId', 'challengeDigest', 'createdAt', 'expiresAt', 'status', ...(joined ? ['input', 'joinedAt'] : [])]);
  const prepared = preparedEnrollment({ enrollmentId: value.enrollmentId, challengeDigest: value.challengeDigest, createdAt: value.createdAt, expiresAt: value.expiresAt });
  requireEnrollment(['pending', 'joined'].includes(value.status));
  if (!joined) return { ...prepared, status: 'pending' };
  const input = joinInput(value.input);
  requireEnrollment(input.enrollmentId === prepared.enrollmentId && integer(value.joinedAt) && value.joinedAt >= prepared.createdAt && value.joinedAt < prepared.expiresAt);
  return { ...prepared, status: 'joined', input, joinedAt: value.joinedAt };
}
export function catalogEnrollment(value) {
  const active = value?.state === 'active';
  exact(value, ['serverId', 'enrollmentId', 'challengeDigest', 'createdAt', 'expiresAt', 'updatedAt', 'state', ...(active ? ['joinRequestId', 'joinedAt'] : [])]);
  const prepared = preparedEnrollment({ enrollmentId: value.enrollmentId, challengeDigest: value.challengeDigest, createdAt: value.createdAt, expiresAt: value.expiresAt });
  requireEnrollment(isUuid(value.serverId) && ['enrolling', 'active'].includes(value.state) && integer(value.updatedAt) && value.updatedAt >= prepared.createdAt);
  if (!active) return { serverId: value.serverId, ...prepared, updatedAt: value.updatedAt, state: 'enrolling' };
  requireEnrollment(isUuid(value.joinRequestId) && integer(value.joinedAt) && value.joinedAt >= prepared.createdAt && value.joinedAt < prepared.expiresAt && value.updatedAt >= value.joinedAt);
  return { serverId: value.serverId, ...prepared, updatedAt: value.updatedAt, state: 'active', joinRequestId: value.joinRequestId, joinedAt: value.joinedAt };
}
export function enrollmentFinalInput(value) {
  exact(value, ['serverId', 'enrollmentId', 'joinRequestId', 'joinedAt']);
  requireEnrollment(isUuid(value.serverId) && isUuid(value.enrollmentId) && isUuid(value.joinRequestId) && integer(value.joinedAt));
  return { serverId: value.serverId, enrollmentId: value.enrollmentId, joinRequestId: value.joinRequestId, joinedAt: value.joinedAt };
}
export const enrollmentFinalId = enrollmentId => `enrollment/${enrollmentId}/joined`;
export function enrollmentReceipt(entry, currentRevision) {
  const stored = JSON.parse(entry.input_json);
  requireEnrollment(stored?.resource === 'enrollment' && ['prepare', 'finalize'].includes(stored.action));
  const { resource, action, ...value } = stored;
  const input = action === 'prepare' ? enrollmentStart(value) : enrollmentFinalInput(value);
  requireEnrollment(entry.input_json === JSON.stringify({ resource, action, ...input }) && entry.request_id === (action === 'prepare' ? input.id : enrollmentFinalId(input.enrollmentId)));
  const result = JSON.parse(entry.result_json); exact(result, ['id', 'revision', 'enrollment']);
  const record = catalogEnrollment(result.enrollment);
  requireEnrollment(result.id === entry.request_id && integer(result.revision) && result.revision > 0 && result.revision <= currentRevision && record.serverId === input.serverId && record.enrollmentId === (action === 'prepare' ? input.id : input.enrollmentId));
  requireEnrollment(action === 'prepare' ? result.revision === input.revision + 1 && record.state === 'enrolling' && record.challengeDigest === input.challengeDigest : record.state === 'active' && record.joinRequestId === input.joinRequestId && record.joinedAt === input.joinedAt);
  return { ...result, enrollment: record };
}
