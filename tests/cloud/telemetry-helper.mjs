import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { heartbeatFlags, heartbeatNode } from './heartbeat-fixture.mjs';
export const telemetryFlags = { ...heartbeatFlags, ENABLE_NODE_TELEMETRY: 'yes' };
export const telemetryOptions = { entryPoint: 'tests/cloud/telemetry-fixture.mjs', telemetry: true };
import { cpu } from '../telemetry-data.mjs';
export { cpu, memory, disk } from '../telemetry-data.mjs';
export async function telemetryNode(f, claims = {}, join = true) { const n = await heartbeatNode(f, claims, join); return { ...n, path: n.path.replace('/heartbeat', '/telemetry'), telemetryContext: { ...n.context, enrollmentId: n.roles.observe.enrollmentId } }; }
export async function telemetryCall(f, c, operation, body, expected = 200, extra = {}) {
  const path = `/node/v2/telemetry/${c.role}/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/${operation}`;
  const response = await f.call(extra.path ?? path, { token: null, headers: { authorization: `Bearer ${c.token}`, ...extra.headers }, body, ...(extra.method ? { method: extra.method } : {}) });
  assert.equal(response.status, expected, response.text); return response.json();
}
export async function telemetrySample(f, c, data = cpu(), memory, disk) {
  const read = await telemetryCall(f, c, 'read', { protocolVersion: 2 }), bootId = randomUUID();
  const started = await telemetryCall(f, c, 'start', { protocolVersion: 2, bootId, previousGeneration: read.result.generation });
  const input = { protocolVersion: 2, bootId, generation: started.result.generation, sequence: 1, cpu: data, ...(memory === undefined ? {} : { sampleVersion: disk === undefined ? 2 : 3, memory, ...(disk === undefined ? {} : { disk }) }) };
  return { input, response: await telemetryCall(f, c, 'sample', input) };
}
export async function telemetryRpc(f, context, operation, args = [], expected = 200) {
  const response = await f.call('/__telemetry_fixture', { body: { context, operation, args } });
  assert.equal(response.status, expected, response.text); return expected === 200 ? response.json() : null;
}
