import { exact } from './protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { nodeContext } from './node-protocol.mjs';

export const TELEMETRY_INTERVAL_MS = 30000;
export const TELEMETRY_STALE_MS = 90000;
export const TELEMETRY_MAX_BYTES = 8192;
export function requireTelemetry(condition) { if (!condition) throw new Error('node telemetry denied or unconfirmed'); }
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => integer(value) && value <= 8640000000000000;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0 && new Date(value).toISOString() === value;
const UNKNOWN = new Set(['warming-up', 'clock-regressed', 'interval-too-short', 'cpu-set-changed', 'counter-regressed', 'no-counter-progress']);
const UNAVAILABLE = new Set(['read-failed', 'invalid-counters', 'clock-unavailable']);
export function cpuSample(value) {
  const keys = ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'logicalCpuCount', 'intervalMs', 'usagePercent'];
  exact(value, keys);
  requireTelemetry(value.schema === 'springbok-cpu/v1' && value.metric === 'cpu' && value.scope === 'linux-proc-stat' && value.unit === 'percent');
  if (value.status === 'unavailable') {
    requireTelemetry(UNAVAILABLE.has(value.reason) && ['sampledAt', 'logicalCpuCount', 'intervalMs', 'usagePercent'].every(key => value[key] === null));
  } else {
    requireTelemetry(iso(value.sampledAt) && integer(value.logicalCpuCount) && value.logicalCpuCount >= 1 && value.logicalCpuCount <= 8192);
    if (value.status === 'unknown') requireTelemetry(UNKNOWN.has(value.reason) && value.intervalMs === null && value.usagePercent === null);
    else requireTelemetry(value.status === 'available' && value.reason === null && integer(value.intervalMs) && value.intervalMs >= TELEMETRY_INTERVAL_MS && Number.isFinite(value.usagePercent) && value.usagePercent >= 0 && value.usagePercent <= 100);
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
export function telemetryContext(value) {
  exact(value, ['ownerId', 'nodeId', 'enrollmentId']);
  const context = nodeContext({ ownerId: value.ownerId, nodeId: value.nodeId }); requireTelemetry(isUuid(value.enrollmentId));
  return { ...context, enrollmentId: value.enrollmentId };
}
export const telemetryName = value => { const c = telemetryContext(value); return `telemetry/v1/${c.ownerId}/${c.nodeId}/${c.enrollmentId}`; };
// 仅内部可信 RPC 上下文，不是密码学 capability；HTTP 必须先经 NodeMailbox 最终事务鉴权。
export function telemetryAuthorization(context, enrollmentId) {
  return { protocolVersion: 2, mode: 'node-telemetry-authorization', ...nodeContext(context), enrollmentId, role: 'observe', executionReady: false };
}
export function authorizedTelemetry(value) {
  exact(value, ['protocolVersion', 'mode', 'ownerId', 'nodeId', 'enrollmentId', 'role', 'executionReady']);
  requireTelemetry(value.protocolVersion === 2 && value.mode === 'node-telemetry-authorization' && value.role === 'observe' && value.executionReady === false);
  return telemetryContext({ ownerId: value.ownerId, nodeId: value.nodeId, enrollmentId: value.enrollmentId });
}
export function telemetryInput(operation, value) {
  if (operation === 'read') { exact(value, ['protocolVersion']); requireTelemetry(value.protocolVersion === 2); return { protocolVersion: 2 }; }
  if (operation === 'start') {
    exact(value, ['protocolVersion', 'bootId', 'previousGeneration']);
    requireTelemetry(value.protocolVersion === 2 && isUuid(value.bootId) && integer(value.previousGeneration) && value.previousGeneration < Number.MAX_SAFE_INTEGER);
    return { protocolVersion: 2, bootId: value.bootId, previousGeneration: value.previousGeneration };
  }
  requireTelemetry(operation === 'sample'); exact(value, ['protocolVersion', 'bootId', 'generation', 'sequence', 'cpu']);
  requireTelemetry(value.protocolVersion === 2 && isUuid(value.bootId) && integer(value.generation) && value.generation > 0 && integer(value.sequence) && value.sequence > 0);
  return { protocolVersion: 2, bootId: value.bootId, generation: value.generation, sequence: value.sequence, cpu: cpuSample(value.cpu) };
}
function accepted(value) {
  exact(value, ['bootId', 'generation', 'sequence', 'cpu', 'receivedAt']);
  const input = telemetryInput('sample', { protocolVersion: 2, bootId: value.bootId, generation: value.generation, sequence: value.sequence, cpu: value.cpu });
  requireTelemetry(timestamp(value.receivedAt)); return { bootId: input.bootId, generation: input.generation, sequence: input.sequence, cpu: input.cpu, receivedAt: value.receivedAt };
}
export function telemetryState(value) {
  if (value === null) return null;
  exact(value, ['generation', 'bootId', 'startedAt', 'latest']);
  requireTelemetry(integer(value.generation) && value.generation > 0 && isUuid(value.bootId) && timestamp(value.startedAt));
  const latest = value.latest === null ? null : accepted(value.latest);
  if (latest) requireTelemetry(latest.generation <= value.generation && (latest.generation === value.generation ? latest.bootId === value.bootId && latest.receivedAt >= value.startedAt : latest.bootId !== value.bootId && latest.receivedAt <= value.startedAt));
  return { generation: value.generation, bootId: value.bootId, startedAt: value.startedAt, latest };
}
export function telemetryTransition(valueState, operation, valueInput, now) {
  const state = telemetryState(valueState), input = telemetryInput(operation, valueInput), generation = state?.generation ?? 0;
  requireTelemetry(timestamp(now));
  if (operation === 'read') return { state, changed: false, result: { generation } };
  if (operation === 'start') {
    if (state?.bootId === input.bootId) {
      requireTelemetry(input.previousGeneration === generation - 1);
      return { state, changed: false, result: { generation, bootId: state.bootId } };
    }
    requireTelemetry(input.previousGeneration === generation && (!state || (now >= state.startedAt && (!state.latest || (now >= state.latest.receivedAt && input.bootId !== state.latest.bootId)))));
    const next = { generation: generation + 1, bootId: input.bootId, startedAt: now, latest: state?.latest ?? null };
    return { state: next, changed: true, result: { generation: next.generation, bootId: next.bootId } };
  }
  requireTelemetry(state && input.generation === generation && input.bootId === state.bootId);
  const latest = state.latest, normalized = { bootId: input.bootId, generation, sequence: input.sequence, cpu: input.cpu };
  if (latest?.generation === generation && input.sequence === latest.sequence) {
    requireTelemetry(JSON.stringify(normalized) === JSON.stringify({ bootId: latest.bootId, generation: latest.generation, sequence: latest.sequence, cpu: latest.cpu }));
    return { state, changed: false, result: { status: 'recorded', sample: latest } };
  }
  requireTelemetry(!latest || latest.generation < generation || input.sequence > latest.sequence);
  requireTelemetry(now >= state.startedAt && (!latest || now >= latest.receivedAt));
  if (latest && now - latest.receivedAt < TELEMETRY_INTERVAL_MS) return { state, changed: false, result: { status: 'deferred', sample: null } };
  const sample = { ...normalized, receivedAt: now };
  return { state: { ...state, latest: sample }, changed: true, result: { status: 'recorded', sample } };
}
export function telemetryResult(context, result) {
  return { protocolVersion: 2, mode: 'node-telemetry-only', ...telemetryContext(context), role: 'observe', executionReady: false, result };
}
export function verifyTelemetryResult(value, credential, operation, input) {
  exact(value, ['protocolVersion', 'mode', 'ownerId', 'nodeId', 'enrollmentId', 'role', 'executionReady', 'result']);
  requireTelemetry(value.protocolVersion === 2 && value.mode === 'node-telemetry-only' && value.executionReady === false && value.role === 'observe' && ['ownerId', 'nodeId', 'enrollmentId', 'role'].every(key => value[key] === credential[key]));
  const result = value.result;
  if (operation === 'read') { exact(result, ['generation']); requireTelemetry(integer(result.generation)); }
  else if (operation === 'start') { exact(result, ['generation', 'bootId']); requireTelemetry(result.generation === input.previousGeneration + 1 && result.bootId === input.bootId); }
  else {
    exact(result, ['status', 'sample']); requireTelemetry(['recorded', 'deferred'].includes(result.status));
    if (result.status === 'deferred') requireTelemetry(result.sample === null);
    else {
      const sample = accepted(result.sample);
      requireTelemetry(JSON.stringify(telemetryInput('sample', { protocolVersion: 2, bootId: sample.bootId, generation: sample.generation, sequence: sample.sequence, cpu: sample.cpu })) === JSON.stringify(telemetryInput('sample', input)));
    }
  }
  return result;
}
export function telemetrySnapshot(context, valueState, now, joined = true) {
  const state = telemetryState(valueState); nodeContext(context); requireTelemetry(timestamp(now));
  const sample = state?.latest ?? null, age = sample && now >= sample.receivedAt ? now - sample.receivedAt : null;
  return { protocolVersion: 2, mode: 'node-telemetry-only', ...context, executionReady: false, evaluatedAt: now,
    thresholds: { intervalMs: TELEMETRY_INTERVAL_MS, staleMs: TELEMETRY_STALE_MS },
    freshness: !joined || age === null ? 'unknown' : age >= TELEMETRY_STALE_MS ? 'stale' : 'fresh',
    reason: !joined ? 'not-joined' : !sample ? 'no-sample' : age === null ? 'cloud-clock-unconfirmed' : 'cloud-received-time', sample };
}
