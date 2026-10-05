import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { adminFixture, origin } from './admin-fixture.mjs';
import { joinChallengeDigest } from '../../cloud/enrollment-contract.mjs';
import { openEnrollmentClient } from '../../src/node-enrollment/client.mjs';
import { installNode } from '../../src/node-install/install.mjs';
import { packageFixture } from '../node-package-fixture.mjs';
import { startDaemon } from '../node-daemon-fixture.mjs';
import { MIN_POLL_MS } from '../../src/node-daemon/loop.mjs';

async function prepared() {
  const p = packageFixture(), f = await adminFixture({ ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_NODE_CREDENTIALS: 'yes', ENABLE_NODE_CHANNEL: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' });
  try {
    const token = f.jwt(), session = (await f.call('/api/admin/state', { token })).json(), headers = { 'x-csrf-token': session.csrf };
    const server = await f.call('/api/admin/servers', { token, headers, body: { id: randomUUID(), revision: 0, action: 'create', name: '常驻验收节点' } }); assert.equal(server.status, 200);
    const context = { ownerId: session.ownerId, nodeId: server.json().server.id };
    const grant = { protocolVersion: 2, origin, ...context, enrollmentId: randomUUID(), challenge: randomBytes(32).toString('hex') };
    const authorized = await f.call('/api/admin/enrollments', { token, headers, body: { id: grant.enrollmentId, revision: 1, serverId: context.nodeId, challengeDigest: await joinChallengeDigest(context, grant.enrollmentId, grant.challenge) } }); assert.equal(authorized.status, 200);
    const roles = join(p.directory, 'roles'), client = openEnrollmentClient({ directory: join(p.directory, 'join'), grant, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
    try { await client.step(); client.exportCredentials(roles); } finally { client.close(); }
    const installed = join(p.directory, 'installed');
    installNode({ packageDirectory: p.packageDirectory, expectedSha256: p.built.sha256, credentialFile: join(roles, 'execute.json'), expectedOrigin: origin, role: 'execute', directory: installed });
    const path = `/api/admin/nodes/${context.nodeId}/probe`, state = await f.call(path, { token }); assert.equal(state.status, 200);
    const request = { requestId: randomUUID(), revision: state.json().revision, challenge: randomBytes(32).toString('hex') };
    const submitted = await f.call(path, { token, headers, body: request }); assert.equal(submitted.status, 200);
    return { ...p, f, installed, path, token, request, async close() { await f.close(); rmSync(p.directory, { recursive: true, force: true }); } };
  } catch (error) { await f.close(); rmSync(p.directory, { recursive: true, force: true }); throw error; }
}
async function dispatch(f, request) {
  assert.equal(new URL(request.url).origin, origin); assert.equal(request.init.redirect, 'error');
  const response = await f.mf.dispatchFetch(request.url, request.init);
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

test('real installed daemon waits at least 30 seconds after lost ack, resends only receipt and drains SIGTERM in-flight', { timeout: 65000 }, async () => {
  const p = await prepared(), children = [], reports = []; let release;
  const hold = new Promise(resolve => { release = resolve; });
  try {
    const c = startDaemon(p.installed, async request => {
      const response = await dispatch(p.f, request);
      if (request.url.endsWith('/report')) {
        reports.push({ body: request.init.body, time: Date.now() });
        if (reports.length === 1) return { error: 'ECONNRESET' }; // 云回执已提交，仅丢失 ack。
        await hold;
      }
      return response;
    }); children.push(c);
    await c.until(s => s.events.some(e => e.status === 'retrying'));
    const ledger = join(p.installed, 'state/ledger.json'), saved = readFileSync(ledger);
    assert.deepEqual(JSON.parse(saved).events.map(e => e.kind), ['started', 'result']);
    await c.until(s => s.requests.filter(r => r.url.endsWith('/report')).length === 2);
    c.child.kill('SIGTERM'); await c.until(s => s.events.some(e => e.event === 'stopping'));
    assert.equal(c.closed, false); assert.deepEqual(readFileSync(ledger), saved);
    release(); await c.until(s => s.closed); assert.equal(c.code, 0, c.stderr);
    assert.equal(reports.length, 2); assert.equal(reports[1].body, reports[0].body); assert.ok(reports[1].time - reports[0].time >= MIN_POLL_MS);
    assert.equal(c.requests.filter(r => r.url.endsWith('/poll')).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(ledger)).events.map(e => e.kind), ['started', 'result', 'ack']);
    assert.equal(existsSync(join(p.installed, 'state/owner.lock')), false); assert.equal(existsSync(join(p.installed, 'state/daemon.lock')), false);
    await p.f.restart(); const completed = readFileSync(ledger);
    const next = startDaemon(p.installed, request => dispatch(p.f, request)); children.push(next);
    await next.until(s => s.events.some(e => e.status === 'idle')); await next.stop();
    assert.equal(next.requests.length, 1); assert.deepEqual(readFileSync(ledger), completed);
    const cloud = await p.f.call(p.path, { token: p.token }); assert.equal(cloud.json().jobs[0].status, 'observed');
    assert.equal(cloud.json().jobs[0].input.requestId, p.request.requestId);
    console.log(JSON.stringify({ retryDelayMs: reports[1].time - reports[0].time, polls: 1, identicalReceiptReports: 2, gracefulDrain: true, executionReady: false }));
  } finally { release(); for (const c of children) await c.dispose(); await p.close(); }
});

test('a real journal write failure is fatal and never becomes a transport retry', async () => {
  const p = await prepared(), state = join(p.installed, 'state'); let c;
  try {
    c = startDaemon(p.installed, async request => { const response = await dispatch(p.f, request); chmodSync(state, 0o500); return response; });
    await c.until(s => s.closed); assert.equal(c.code, 2); assert.equal(c.requests.length, 1); assert.equal(c.events.some(e => e.status === 'retrying'), false);
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'ledger.json'))).events, []);
    const cloud = await p.f.call(p.path, { token: p.token }); assert.equal(cloud.json().jobs[0].status, 'claimed');
    assert.equal(existsSync(join(state, 'owner.lock')), true);
  } finally { chmodSync(state, 0o700); await c?.dispose(); await p.close(); }
});
