import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installNode } from '../src/node-install/install.mjs';
import { identityResult } from '../cloud/credential-contract.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';
import { startDaemon, responseJson } from './node-daemon-fixture.mjs';
import { heartbeatResponder } from './node-heartbeat-fixture.mjs';
import { telemetryResponder } from './node-telemetry-fixture.mjs';

function setup(role) {
  const f = packageFixture(), r = roleFixture(f.directory, role), directory = join(f.directory, 'installed');
  installNode({ packageDirectory: f.packageDirectory, expectedSha256: f.built.sha256, credentialFile: r.credentialFile, expectedOrigin: r.credential.origin, role, directory });
  const context = { ownerId: r.credential.ownerId, nodeId: r.credential.nodeId };
  const response = role === 'observe' ? identityResult(context, r.credential.enrollmentId, role) : { protocolVersion: 2, ...context, enrollmentId: r.credential.enrollmentId, role, executionReady: false, result: { status: 'idle' } };
  return { ...f, ...r, installed: directory, response };
}

test('each installed role holds one daemon instance, stops during wait and can cleanly restart', async () => {
  for (const role of ['execute', 'observe']) {
    const f = setup(role), children = [];
    try {
      const beat = heartbeatResponder(f.credential);
      const telemetry = telemetryResponder(f.credential);
      const first = startDaemon(f.installed, r => beat(r) ?? telemetry(r) ?? responseJson(f.response)); children.push(first);
      await first.until(s => s.events.some(e => e.event === 'heartbeat' && e.status === 'recorded'));
      if (role === 'observe') await first.until(s => s.events.some(e => e.event === 'telemetry' && e.status === 'recorded'));
      assert.ok(first.events.some(e => e.status === (role === 'execute' ? 'idle' : 'authenticated')));
      const duplicate = startDaemon(f.installed, () => { throw new Error('duplicate must not request'); }); children.push(duplicate);
      await duplicate.until(s => s.closed); assert.equal(duplicate.code, 2); assert.equal(duplicate.requests.length, 0);
      if (role === 'execute') {
        const probe = startDaemon(f.installed, () => { throw new Error('owned journal must not poll'); }, 'node-run.mjs', 'probe'); children.push(probe);
        await probe.until(s => s.closed); assert.equal(probe.code, 1); assert.equal(probe.requests.length, 0);
      }
      assert.equal(fs.statSync(join(f.installed, 'state/daemon.lock')).mode & 0o077, 0);
      await first.stop('SIGTERM'); assert.equal(first.requests.length, role === 'observe' ? 7 : 4); assert.equal(fs.existsSync(join(f.installed, 'state/daemon.lock')), false);
      assert.deepEqual(first.requests.filter(r => r.url.includes('/heartbeat/')).map(r => new URL(r.url).pathname.split('/').at(-1)), ['read', 'start', 'sample']);
      const second = startDaemon(f.installed, r => beat(r) ?? telemetry(r) ?? responseJson(f.response)); children.push(second);
      await second.until(s => s.events.some(e => e.event === 'status')); await second.stop('SIGINT');
      assert.equal(role === 'observe' && fs.existsSync(join(f.installed, 'state/ledger.json')), false);
      for (const c of children) assert.equal((c.stdout + c.stderr).includes(f.credential.token), false);
    } finally { for (const c of children) await c.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test('unknown terminates and survives restart without further network calls', async () => {
  const f = setup('execute'), children = [];
  try {
    const first = startDaemon(f.installed, () => responseJson({ ...f.response, result: { status: 'unknown', requestId: randomUUID() } })); children.push(first);
    await first.until(s => s.closed); assert.equal(first.code, 2); assert.equal(first.events.at(-1).event, 'blocked');
    const ledger = fs.readFileSync(join(f.installed, 'state/ledger.json'));
    const second = startDaemon(f.installed, () => { throw new Error('unknown must not poll again'); }); children.push(second);
    await second.until(s => s.closed); assert.equal(second.code, 2); assert.equal(second.requests.length, 0); assert.deepEqual(fs.readFileSync(join(f.installed, 'state/ledger.json')), ledger);
  } finally { for (const c of children) await c.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('process death preserves locks and a retryable transport failure remains stoppable', async () => {
  const f = setup('execute'), children = [];
  try {
    const first = startDaemon(f.installed, () => ({ error: 'ECONNRESET' })); children.push(first);
    await first.until(s => s.events.some(e => e.status === 'retrying'));
    await first.until(s => s.events.some(e => e.event === 'heartbeat' && e.status === 'unavailable'));
    await first.stop('SIGKILL', null);
    const file = join(f.installed, 'state/daemon.lock'), bytes = fs.readFileSync(file);
    assert.equal(fs.existsSync(join(f.installed, 'state/owner.lock')), true);
    const second = startDaemon(f.installed, () => { throw new Error('stale lock must block'); }); children.push(second);
    await second.until(s => s.closed); assert.equal(second.code, 2); assert.equal(second.requests.length, 0); assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { for (const c of children) await c.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
  const g = setup('observe'); let c;
  try { c = startDaemon(g.installed, () => responseJson({}, 503)); await c.until(s => s.events.some(e => e.event === 'telemetry' && e.status === 'unavailable')); await c.stop(); assert.equal(c.requests.length, 3); }
  finally { await c?.dispose(); fs.rmSync(g.directory, { recursive: true, force: true }); }
});

test('identity and protocol failures terminate instead of entering a retry loop', async () => {
  for (const response of [responseJson({}, 409), responseJson({ status: 'authenticated', token: 'untrusted' }), responseJson({}, 307)]) {
    const f = setup('observe'); let c;
    try {
      c = startDaemon(f.installed, () => response); await c.until(s => s.closed);
      assert.equal(c.code, 2); assert.equal(c.requests.length, 1); assert.equal(c.events.some(e => e.status === 'retrying'), false);
      assert.equal(fs.existsSync(join(f.installed, 'state/daemon.lock')), false);
    } finally { await c?.dispose(); fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});
