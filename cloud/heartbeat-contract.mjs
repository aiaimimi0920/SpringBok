import { exact } from './protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { nodeContext } from './node-protocol.mjs';
import { nodeRole } from './credential-contract.mjs';

export const HEARTBEAT_INTERVAL_MS = 30000;
export const HEARTBEAT_STALE_MS = 90000;
export const HEARTBEAT_OFFLINE_MS = 300000;
export function requireHeartbeat(condition) { if (!condition) throw new Error('node heartbeat denied or unconfirmed'); }
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => integer(value) && value <= 8640000000000000;
export function heartbeatInput(operation, value) {
  if (operation === 'read') { exact(value, ['protocolVersion']); }
  else if (operation === 'start') {
    exact(value, ['protocolVersion', 'bootId', 'previousGeneration']);
    requireHeartbeat(isUuid(value.bootId) && integer(value.previousGeneration) && value.previousGeneration < Number.MAX_SAFE_INTEGER);
  } else if (operation === 'sample') {
    exact(value, ['protocolVersion', 'bootId', 'generation', 'sequence', 'sampledAt']);
    requireHeartbeat(isUuid(value.bootId) && integer(value.generation) && value.generation > 0 && integer(value.sequence) && value.sequence > 0 && timestamp(value.sampledAt));
  } else throw new Error('unknown heartbeat operation');
  requireHeartbeat(value.protocolVersion === 2);
  return { ...value };
}
function sample(value) {
  exact(value, ['bootId', 'generation', 'sequence', 'sampledAt', 'receivedAt']);
  heartbeatInput('sample', { protocolVersion: 2, bootId: value.bootId, generation: value.generation, sequence: value.sequence, sampledAt: value.sampledAt });
  requireHeartbeat(timestamp(value.receivedAt)); return value;
}
function roleState(value) {
  if (value === null) return null;
  exact(value, ['generation', 'bootId', 'startedAt', 'latest']);
  requireHeartbeat(integer(value.generation) && value.generation > 0 && isUuid(value.bootId) && timestamp(value.startedAt));
  if (value.latest !== null) {
    sample(value.latest);
    requireHeartbeat(value.latest.generation <= value.generation && (value.latest.generation === value.generation ? value.latest.bootId === value.bootId && value.latest.receivedAt >= value.startedAt : value.latest.bootId !== value.bootId && value.latest.receivedAt <= value.startedAt));
  }
  return value;
}
export function heartbeatState(value) {
  exact(value, ['execute', 'observe']); roleState(value.execute); roleState(value.observe); return value;
}
// 只保留两个角色的当前代次和最新样本。代次不是凭据 epoch，不能代替 N04/N05。
export function heartbeatTransition(state, role, operation, value, now) {
  heartbeatState(state); nodeRole(role); heartbeatInput(operation, value); requireHeartbeat(timestamp(now));
  const current = state[role], generation = current?.generation ?? 0;
  if (operation === 'read') return { state, changed: false, result: { generation } };
  if (operation === 'start') {
    if (current?.bootId === value.bootId) {
      requireHeartbeat(value.previousGeneration === generation - 1);
      return { state, changed: false, result: { generation, bootId: current.bootId } };
    }
    requireHeartbeat(value.previousGeneration === generation && generation < Number.MAX_SAFE_INTEGER && (!current || (now >= current.startedAt && (!current.latest || now >= current.latest.receivedAt))));
    const next = { generation: generation + 1, bootId: value.bootId, startedAt: now, latest: current?.latest ?? null };
    return { state: { ...state, [role]: next }, changed: true, result: { generation: next.generation, bootId: next.bootId } };
  }
  requireHeartbeat(current && value.generation === generation && value.bootId === current.bootId);
  const latest = current.latest;
  if (latest?.generation === generation && value.sequence === latest.sequence) {
    requireHeartbeat(value.sampledAt === latest.sampledAt);
    return { state, changed: false, result: { status: 'recorded', sample: latest } }; // 精确重送不刷新 receivedAt。
  }
  requireHeartbeat(!latest || latest.generation < generation || value.sequence > latest.sequence);
  requireHeartbeat(now >= current.startedAt && (!latest || now >= latest.receivedAt));
  if (latest && now - latest.receivedAt < HEARTBEAT_INTERVAL_MS) return { state, changed: false, result: { status: 'deferred', sample: null } };
  const accepted = { bootId: value.bootId, generation, sequence: value.sequence, sampledAt: value.sampledAt, receivedAt: now };
  return { state: { ...state, [role]: { ...current, latest: accepted } }, changed: true, result: { status: 'recorded', sample: accepted } };
}
export function heartbeatResult(context, enrollmentId, role, result) {
  return { protocolVersion: 2, mode: 'node-heartbeat-only', ...nodeContext(context), enrollmentId, role: nodeRole(role), executionReady: false, result };
}
export function verifyHeartbeatResult(value, credential, operation, input) {
  exact(value, ['protocolVersion', 'mode', 'ownerId', 'nodeId', 'enrollmentId', 'role', 'executionReady', 'result']);
  requireHeartbeat(value.protocolVersion === 2 && value.mode === 'node-heartbeat-only' && value.executionReady === false && ['ownerId', 'nodeId', 'enrollmentId', 'role'].every(key => value[key] === credential[key]));
  const result = value.result;
  if (operation === 'read') { exact(result, ['generation']); requireHeartbeat(integer(result.generation)); }
  else if (operation === 'start') {
    exact(result, ['generation', 'bootId']); requireHeartbeat(result.generation === input.previousGeneration + 1 && result.bootId === input.bootId);
  } else {
    exact(result, ['status', 'sample']); requireHeartbeat(['recorded', 'deferred'].includes(result.status));
    if (result.status === 'deferred') requireHeartbeat(result.sample === null);
    else { sample(result.sample); requireHeartbeat(['bootId', 'generation', 'sequence', 'sampledAt'].every(key => result.sample[key] === input[key])); }
  }
  return result;
}
export function heartbeatSnapshot(context, state, now, joined) {
  heartbeatState(state); requireHeartbeat(timestamp(now));
  const roles = Object.fromEntries(['execute', 'observe'].map(role => {
    const latest = state[role]?.latest ?? null, age = latest && now >= latest.receivedAt ? now - latest.receivedAt : null;
    const status = !joined || age === null ? 'unknown' : age >= HEARTBEAT_OFFLINE_MS ? 'offline' : age >= HEARTBEAT_STALE_MS ? 'stale' : 'online';
    return [role, { status, reason: !joined ? 'not-joined' : !latest ? 'no-sample' : age === null ? 'cloud-clock-unconfirmed' : 'cloud-received-time', sample: latest }];
  }));
  return { protocolVersion: 2, mode: 'node-heartbeat-only', ...nodeContext(context), executionReady: false, evaluatedAt: now,
    thresholds: { intervalMs: HEARTBEAT_INTERVAL_MS, staleMs: HEARTBEAT_STALE_MS, offlineMs: HEARTBEAT_OFFLINE_MS }, roles };
}
