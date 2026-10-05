import { signSession, sameProof } from './access.mjs';
import { isUuid } from './catalog-contract.mjs';
import { nodeMailboxName } from './node-protocol.mjs';
import { enrollmentStart, enrollmentTarget, joinInput, requireEnrollment } from './enrollment-contract.mjs';

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export const enrollmentEnabled = env => env.ENABLE_ADMIN === 'yes' && env.ENABLE_CATALOG === 'yes' && env.ENABLE_NODE_MAILBOX === 'yes' && env.ENABLE_NODE_ENROLLMENT === 'yes' && !!env.REGISTRY && !!env.NODES;
const catalogFor = (env, ownerId) => env.REGISTRY.get(env.REGISTRY.idFromName(`catalog/v1/${ownerId}`));
const nodeFor = (env, context) => env.NODES.get(env.NODES.idFromName(nodeMailboxName(context)));
function preparation(record) {
  return { enrollmentId: record.enrollmentId, challengeDigest: record.challengeDigest, createdAt: record.createdAt, expiresAt: record.expiresAt };
}
async function finalize(catalog, context, joined) {
  requireEnrollment(joined.status === 'joined' && joined.ownerId === context.ownerId && joined.nodeId === context.nodeId);
  const current = await catalog.enrollmentSnapshot(context.ownerId, context.nodeId);
  requireEnrollment(current.enrollment?.enrollmentId === joined.enrollmentId);
  return catalog.finalizeEnrollment(context.ownerId, { serverId: context.nodeId, enrollmentId: joined.enrollmentId, joinRequestId: joined.requestId, joinedAt: joined.joinedAt });
}
export async function adminEnrollmentRequest(request, env, session, readBody) {
  if (!enrollmentEnabled(env)) return reply({ error: 'node enrollment disabled' }, 503);
  const url = new URL(request.url), catalog = catalogFor(env, session.actor);
  try {
    if (request.method === 'GET' && url.pathname.startsWith('/api/admin/enrollments/')) {
      const serverId = url.pathname.slice('/api/admin/enrollments/'.length); requireEnrollment(isUuid(serverId));
      const current = await catalog.enrollmentSnapshot(session.actor, serverId);
      const context = { ownerId: session.actor, nodeId: serverId };
      const node = await nodeFor(env, context).enrollmentSnapshot(context);
      return reply({ ...current, node }); // 只读，不隐式准备或完成目录。
    }
    if (request.method !== 'POST' || !['/api/admin/enrollments', '/api/admin/enrollments/reconcile'].includes(url.pathname)) return reply({ error: 'unknown enrollment route' }, 404);
    if (request.headers.get('origin') !== session.origin || !sameProof(request.headers.get('x-csrf-token'), await signSession(session, 'csrf', null))) return reply({ error: 'refresh this authenticated session' }, 403);
    const value = await readBody(request);
    let record;
    if (url.pathname === '/api/admin/enrollments') record = (await catalog.prepareEnrollment(session.actor, enrollmentStart(value))).enrollment;
    else {
      const target = enrollmentTarget(value), current = await catalog.enrollmentSnapshot(session.actor, target.serverId);
      requireEnrollment(current.enrollment?.enrollmentId === target.enrollmentId); record = current.enrollment;
    }
    const context = { ownerId: session.actor, nodeId: record.serverId }, node = nodeFor(env, context);
    try {
      const state = await node.prepareEnrollment(context, preparation(record));
      if (state.status === 'joined') {
        await finalize(catalog, context, state);
        return reply({ status: 'joined', directoryState: 'active', reconciliationRequired: false, executionReady: false, enrollmentId: record.enrollmentId });
      }
      return reply({ status: state.status, directoryState: 'enrolling', reconciliationRequired: false, executionReady: false, enrollmentId: record.enrollmentId, expiresAt: record.expiresAt });
    } catch {
      return reply({ status: 'uncertain', directoryState: record.state, reconciliationRequired: true, executionReady: false, enrollmentId: record.enrollmentId }, 202);
    }
  } catch { return reply({ error: 'enrollment rejected, stale or persistence uncertain; inspect before retrying' }, 409); }
}
export async function nodeEnrollmentRequest(request, env, readBody) {
  if (!enrollmentEnabled(env)) return reply({ error: 'node enrollment disabled' }, 503);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.search || request.headers.has('cookie') || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return reply({ error: 'join request denied' }, 403);
  const match = /^\/node\/v2\/join\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (!match || !isUuid(match[2]) || request.method !== 'POST') return reply({ error: 'unknown join route' }, 404);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (!token) return reply({ error: 'join request denied' }, 403);
  const context = { ownerId: match[1], nodeId: match[2] }; // 仅寻址提示，不能授权；能力由权威节点事务验证。
  try {
    const input = joinInput(await readBody(request));
    const joined = await nodeFor(env, context).joinEnrollment(context, token[1], input);
    try {
      await finalize(catalogFor(env, context.ownerId), context, joined);
      return reply({ ...joined, directoryState: 'active', reconciliationRequired: false });
    } catch { return reply({ ...joined, directoryState: 'uncertain', reconciliationRequired: true }, 202); }
  } catch { return reply({ error: 'join denied, expired, conflicting or persistence uncertain' }, 409); }
}
