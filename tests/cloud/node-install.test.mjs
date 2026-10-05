import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { adminFixture, origin } from './admin-fixture.mjs';
import { joinChallengeDigest } from '../../cloud/enrollment-contract.mjs';
import { openEnrollmentClient } from '../../src/node-enrollment/client.mjs';
import { packageFixture } from '../node-package-fixture.mjs';

async function runInstalled(f, directory, action, expectedStatus = 0) {
  const loader = fileURLToPath(new URL('./installed-fetch-fixture.mjs', import.meta.url));
  const child = fork(join(directory, 'release/scripts/node-run.mjs'), ['--installation', directory, '--action', action], { execArgv: ['--import', loader], silent: true });
  let stdout = '', stderr = '', requests = 0, fault;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.on('message', async message => {
    try {
      assert.equal(new URL(message.url).origin, origin); assert.equal(message.init.redirect, 'error'); requests++;
      const response = await f.mf.dispatchFetch(message.url, message.init), body = await response.text();
      if (child.connected) child.send({ id: message.id, status: response.status, headers: Object.fromEntries(response.headers), body });
    } catch (error) { fault = error; if (child.connected) child.send({ id: message.id, error: true }); }
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (fault) throw fault; assert.equal(code, expectedStatus, stderr);
    return { stdout, stderr, requests, value: stdout ? JSON.parse(stdout) : null };
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
}

test('installed single-role CLIs authenticate with real workerd and preserve probe receipt across reinstall and restart', async () => {
  assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0);
  const p = packageFixture(), f = await adminFixture({ ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_NODE_CREDENTIALS: 'yes', ENABLE_NODE_CHANNEL: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' });
  try {
    const token = f.jwt(), session = (await f.call('/api/admin/state', { token })).json(), headers = { 'x-csrf-token': session.csrf };
    const server = await f.call('/api/admin/servers', { token, headers, body: { id: randomUUID(), revision: 0, action: 'create', name: '安装验收节点' } }); assert.equal(server.status, 200);
    const grant = { protocolVersion: 2, origin, ownerId: session.ownerId, nodeId: server.json().server.id, enrollmentId: randomUUID(), challenge: randomBytes(32).toString('hex') };
    const context = { ownerId: grant.ownerId, nodeId: grant.nodeId };
    const authorized = await f.call('/api/admin/enrollments', { token, headers, body: { id: grant.enrollmentId, revision: 1, serverId: grant.nodeId, challengeDigest: await joinChallengeDigest(context, grant.enrollmentId, grant.challenge) } }); assert.equal(authorized.status, 200);
    const roles = join(p.directory, 'roles'), client = openEnrollmentClient({ directory: join(p.directory, 'join'), grant, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
    try { assert.equal((await client.step()).status, 'joined'); client.exportCredentials(roles); } finally { client.close(); }
    function install(role) {
      const directory = join(p.directory, `${role}-installed`);
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/node-install.mjs', import.meta.url)), '--package', p.packageDirectory, '--sha256', p.built.sha256, '--credential', join(roles, `${role}.json`), '--expected-origin', origin, '--role', role, '--directory', directory], { encoding: 'utf8', timeout: 10000 });
      assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).executionReady, false); return directory;
    }
    const execute = install('execute'), observe = install('observe');
    const outputs = [];
    for (const [role, directory] of [['execute', execute], ['observe', observe]]) {
      const result = await runInstalled(f, directory, 'identity'); outputs.push(result);
      assert.equal(result.value.status, 'authenticated'); assert.equal(result.value.role, role); assert.equal(result.value.nodeId, grant.nodeId); assert.equal(result.requests, 1);
    }
    const refused = await runInstalled(f, observe, 'probe', 1); outputs.push(refused); assert.equal(refused.requests, 0);
    const probePath = `/api/admin/nodes/${grant.nodeId}/probe`, before = await f.call(probePath, { token }); assert.equal(before.status, 200);
    const requestId = randomUUID(), submitted = await f.call(probePath, { token, headers, body: { requestId, revision: before.json().revision, challenge: randomBytes(32).toString('hex') } }); assert.equal(submitted.status, 200, submitted.text);
    const observed = await runInstalled(f, execute, 'probe'); outputs.push(observed); assert.equal(observed.value.status, 'observed'); assert.equal(observed.requests, 2);
    const ledger = join(execute, 'state/ledger.json'), saved = readFileSync(ledger);
    install('execute'); assert.deepEqual(readFileSync(ledger), saved); await f.restart();
    const idle = await runInstalled(f, execute, 'probe'); outputs.push(idle); assert.equal(idle.value.status, 'idle'); assert.deepEqual(readFileSync(ledger), saved);
    const cloud = await f.call(`/api/admin/nodes/${grant.nodeId}/probe`); assert.equal(cloud.status, 200); assert.equal(cloud.json().jobs[0].status, 'observed'); assert.equal(cloud.json().jobs[0].input.requestId, requestId);
    for (const role of ['execute', 'observe']) {
      const secret = JSON.parse(readFileSync(join(roles, `${role}.json`))).token;
      for (const result of outputs) assert.equal((result.stdout + result.stderr).includes(secret), false);
    }
  } finally { await f.close(); rmSync(p.directory, { recursive: true, force: true }); }
});
