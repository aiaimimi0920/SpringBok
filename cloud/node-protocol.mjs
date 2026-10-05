import { exact } from './protocol.mjs';
import { isUuid } from './catalog-contract.mjs';

export const NODE_PROTOCOL_VERSION = 2;
export const MAX_NODE_JOBS = 100;
export const PROBE_TTL_MS = 120000;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function requireNode(condition) { if (!condition) throw new Error('invalid node protocol or binding'); }

// 只有可信服务端调用方可以提供该上下文；此解析器不认证 HTTP 请求。
export function nodeContext(value) {
  exact(value, ['ownerId', 'nodeId']);
  requireNode(hex(value.ownerId) && isUuid(value.nodeId));
  return { ownerId: value.ownerId, nodeId: value.nodeId };
}
export function nodeMailboxName(context) {
  const { ownerId, nodeId } = nodeContext(context);
  return `node/v${NODE_PROTOCOL_VERSION}/${ownerId}/${nodeId}`;
}
export function probeRequest(value) {
  exact(value, ['requestId', 'revision', 'challenge']);
  requireNode(isUuid(value.requestId) && integer(value.revision) && hex(value.challenge));
  return { requestId: value.requestId, revision: value.revision, challenge: value.challenge };
}
function planFields(context, request) {
  return { protocolVersion: NODE_PROTOCOL_VERSION, ...nodeContext(context), serviceId: null,
    environment: 'control', operation: 'protocol-probe', ...probeRequest(request) };
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function probePlan(context, request) {
  const fields = planFields(context, request);
  return { ...fields, planDigest: await digest(fields) };
}
export function nodePlan(value, context) {
  exact(value, ['protocolVersion', 'ownerId', 'nodeId', 'serviceId', 'environment', 'operation', 'requestId', 'revision', 'challenge', 'planDigest']);
  const fields = planFields(context, { requestId: value.requestId, revision: value.revision, challenge: value.challenge });
  requireNode(Object.entries(fields).every(([key, field]) => value[key] === field) && typeof value.planDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.planDigest));
  return { ...fields, planDigest: value.planDigest };
}
export function probeReceipt(value) {
  exact(value, ['protocolVersion', 'requestId', 'planDigest', 'challenge', 'outcome']);
  requireNode(value.protocolVersion === NODE_PROTOCOL_VERSION && isUuid(value.requestId) && hex(value.challenge) && typeof value.planDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.planDigest) && ['observed', 'unknown'].includes(value.outcome));
  return { protocolVersion: value.protocolVersion, requestId: value.requestId, planDigest: value.planDigest, challenge: value.challenge, outcome: value.outcome };
}
export function nodeLedger(value, context) {
  nodeContext(context); exact(value, ['revision', 'jobs']);
  requireNode(integer(value.revision) && Array.isArray(value.jobs) && value.jobs.length <= MAX_NODE_JOBS);
  const ids = new Set(); let revision = 0;
  for (const [index, job] of value.jobs.entries()) {
    exact(job, Object.hasOwn(job, 'receipt') ? ['input', 'status', 'expiresAt', 'receipt'] : ['input', 'status', 'expiresAt']);
    const input = nodePlan(job.input, context);
    requireNode(!ids.has(input.requestId) && input.revision === revision && integer(job.expiresAt) && ['queued', 'claimed', 'observed', 'unknown', 'expired'].includes(job.status));
    requireNode(index === value.jobs.length - 1 || ['observed', 'expired'].includes(job.status));
    if (Object.hasOwn(job, 'receipt')) {
      const receipt = probeReceipt(job.receipt);
      requireNode(receipt.requestId === input.requestId && receipt.challenge === input.challenge && receipt.planDigest === input.planDigest && receipt.outcome === job.status);
    }
    requireNode(job.status !== 'observed' || Object.hasOwn(job, 'receipt'));
    revision += { queued: 1, claimed: 2, observed: 3, unknown: 3, expired: 2 }[job.status];
    ids.add(input.requestId);
  }
  requireNode(value.revision === revision && value.jobs.filter(job => ['queued', 'claimed', 'unknown'].includes(job.status)).length <= 1);
  return structuredClone(value);
}
export async function verifyNodePlans(state, context) {
  for (const job of nodeLedger(state, context).jobs) {
    const expected = await probePlan(context, { requestId: job.input.requestId, revision: job.input.revision, challenge: job.input.challenge });
    requireNode(expected.planDigest === job.input.planDigest);
  }
}
export function nodeTransition(current, context, operation, value, now) {
  const state = nodeLedger(current, context); let response, changed = false;
  requireNode(integer(now) && Number.isSafeInteger(now + PROBE_TTL_MS));
  if (operation === 'submitProbe') {
    const input = nodePlan(value, context), prior = state.jobs.find(job => job.input.requestId === input.requestId);
    if (prior) {
      requireNode(JSON.stringify(nodePlan(prior.input, context)) === JSON.stringify(input));
      return { state, changed: false, response: { requestId: input.requestId, status: prior.status } };
    }
    requireNode(input.revision === state.revision && state.jobs.length < MAX_NODE_JOBS && !state.jobs.some(job => ['queued', 'claimed', 'unknown'].includes(job.status)));
    state.jobs.push({ input, status: 'queued', expiresAt: now + PROBE_TTL_MS }); changed = true;
    response = { requestId: input.requestId, status: 'queued' };
  } else if (operation === 'pollProbe') {
    exact(value, ['protocolVersion']); requireNode(value.protocolVersion === NODE_PROTOCOL_VERSION);
    const job = state.jobs.find(item => ['queued', 'claimed', 'unknown'].includes(item.status));
    if (!job) response = { status: 'idle' };
    else if (job.status === 'queued') {
      if (now >= job.expiresAt) { job.status = 'expired'; response = { status: 'expired', requestId: job.input.requestId }; }
      else { job.status = 'claimed'; response = { status: 'delivery', input: structuredClone(job.input) }; }
      changed = true;
    } else {
      if (job.status === 'claimed' && now >= job.expiresAt) { job.status = 'unknown'; changed = true; }
      response = { status: job.status, requestId: job.input.requestId };
    }
  } else if (operation === 'reportProbe') {
    const receipt = probeReceipt(value), job = state.jobs.find(item => item.input.requestId === receipt.requestId);
    requireNode(job && job.input.planDigest === receipt.planDigest && job.input.challenge === receipt.challenge && ['claimed', 'unknown', 'observed'].includes(job.status));
    if (job.receipt) requireNode(JSON.stringify(probeReceipt(job.receipt)) === JSON.stringify(receipt));
    if (job.status === 'claimed' && now >= job.expiresAt) { job.status = 'unknown'; changed = true; }
    if (job.status !== 'unknown' && !job.receipt) { job.status = receipt.outcome; job.receipt = receipt; changed = true; }
    response = { status: job.status, requestId: receipt.requestId };
    // 相同回执幂等；已未知的任务不接受迟到成功，也不重投。
  } else throw new Error('unsupported node operation');
  if (changed) { requireNode(Number.isSafeInteger(state.revision + 1)); state.revision++; }
  return { state: nodeLedger(state, context), response, changed };
}
