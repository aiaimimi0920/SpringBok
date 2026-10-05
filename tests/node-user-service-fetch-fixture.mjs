// 只在一次性 CI 用户 manager 的 test-only drop-in 中加载；不分发到控制客户端包。
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { identityResult } from '../cloud/credential-contract.mjs';
import { heartbeatTransition, heartbeatResult } from '../cloud/heartbeat-contract.mjs';
import { telemetryTransition, telemetryResult } from '../cloud/telemetry-contract.mjs';

const configPath = process.env.SPRINGBOK_SYSTEMD_TEST_CONFIG;
assert.ok(configPath);
let heartbeatState = { execute: null, observe: null };
let telemetryState = null;
globalThis.fetch = async (url, init) => {
  const { credential: c, mode, log } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const pathname = c.role === 'observe' ? `/node/v2/identity/observe/${c.ownerId}/${c.nodeId}` : `/node/v2/channel/execute/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/poll`;
  const heartbeatPrefix = `${c.origin}/node/v2/heartbeat/${c.role}/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/`, beat = url.startsWith(heartbeatPrefix);
  const telemetryPrefix = `${c.origin}/node/v2/telemetry/observe/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/`, telemetry = url.startsWith(telemetryPrefix);
  if (telemetry) assert.equal(c.role, 'observe');
  if (!beat && !telemetry) assert.equal(url, c.origin + pathname); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, `Bearer ${c.token}`);
  const emit = event => fs.appendFileSync(log, JSON.stringify({ event, heartbeat: beat, telemetry, operation: new URL(url).pathname.split('/').at(-1), pid: process.pid, at: Date.now() }) + '\n', { mode: 0o600 });
  emit('request');
  if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 1500));
  const context = { ownerId: c.ownerId, nodeId: c.nodeId };
  if (beat) {
    const transition = heartbeatTransition(heartbeatState, c.role, url.slice(heartbeatPrefix.length), JSON.parse(init.body), Date.now()); heartbeatState = transition.state;
    emit('response'); return Response.json(heartbeatResult(context, c.enrollmentId, c.role, transition.result));
  }
  if (telemetry) {
    const transition = telemetryTransition(telemetryState, url.slice(telemetryPrefix.length), JSON.parse(init.body), Date.now()); telemetryState = transition.state;
    emit('response'); return Response.json(telemetryResult({ ...context, enrollmentId: c.enrollmentId }, transition.result));
  }
  const value = c.role === 'observe' ? identityResult(context, c.enrollmentId, c.role) : {
    protocolVersion: 2, ...context, enrollmentId: c.enrollmentId, role: c.role, executionReady: false,
    result: mode === 'unknown' ? { status: 'unknown', requestId: randomUUID() } : { status: 'idle' },
  };
  emit('response');
  return new Response(JSON.stringify(value), { status: mode === 'denied' ? 401 : 200, headers: { 'content-type': 'application/json' } });
};
