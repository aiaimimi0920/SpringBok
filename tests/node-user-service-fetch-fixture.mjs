// 只在一次性 CI 用户 manager 的 test-only drop-in 中加载；不分发到控制客户端包。
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { identityResult } from '../cloud/credential-contract.mjs';

const configPath = process.env.SPRINGBOK_SYSTEMD_TEST_CONFIG;
assert.ok(configPath);
globalThis.fetch = async (url, init) => {
  const { credential: c, mode, log } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const pathname = c.role === 'observe' ? `/node/v2/identity/observe/${c.ownerId}/${c.nodeId}` : `/node/v2/channel/execute/${c.ownerId}/${c.nodeId}/${c.enrollmentId}/poll`;
  assert.equal(url, c.origin + pathname); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, `Bearer ${c.token}`);
  const emit = event => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid, at: Date.now() }) + '\n', { mode: 0o600 });
  emit('request');
  if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 1500));
  const context = { ownerId: c.ownerId, nodeId: c.nodeId };
  const value = c.role === 'observe' ? identityResult(context, c.enrollmentId, c.role) : {
    protocolVersion: 2, ...context, enrollmentId: c.enrollmentId, role: c.role, executionReady: false,
    result: mode === 'unknown' ? { status: 'unknown', requestId: randomUUID() } : { status: 'idle' },
  };
  emit('response');
  return new Response(JSON.stringify(value), { status: mode === 'denied' ? 401 : 200, headers: { 'content-type': 'application/json' } });
};
