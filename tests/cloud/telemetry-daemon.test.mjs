import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminFixture, origin } from './admin-fixture.mjs';
import { telemetryFlags, telemetryOptions, telemetryNode } from './telemetry-helper.mjs';
import { packageFixture } from '../node-package-fixture.mjs';
import { installNode } from '../../src/node-install/install.mjs';
import { startDaemon } from '../node-daemon-fixture.mjs';

test('actual v7 observe installation samples real Linux CPU, memory, disk and network into workerd/admin latest; execute never uploads and SIGTERM drains', { timeout: 65000 }, async () => {
  assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0);
  const p = packageFixture(), f = await adminFixture(telemetryFlags, telemetryOptions), children = [], samples = []; let release;
  try {
    const n = await telemetryNode(f), hold = new Promise(resolve => { release = resolve; });
    const installed = {};
    for (const role of ['observe', 'execute']) {
      const credentialFile = join(p.directory, role + '.json'); writeFileSync(credentialFile, JSON.stringify(n.roles[role]), { flag: 'wx', mode: 0o600 });
      installed[role] = join(p.directory, 'installed-' + role);
      installNode({ packageDirectory: p.packageDirectory, expectedSha256: p.built.sha256, credentialFile, expectedOrigin: origin, role, directory: installed[role] });
      const c = startDaemon(installed[role], async request => {
        assert.equal(new URL(request.url).origin, origin); assert.equal(request.init.redirect, 'error');
        const response = await f.mf.dispatchFetch(request.url, request.init), body = await response.text();
        if (request.url.includes('/telemetry/') && request.url.endsWith('/sample')) {
          assert.equal(role, 'observe'); samples.push({ input: JSON.parse(request.init.body), result: JSON.parse(body), at: Date.now() });
          if (samples.length === 2) await hold;
        }
        return { status: response.status, headers: Object.fromEntries(response.headers), body };
      }); children.push(c);
    }
    const observe = children[0], execute = children[1];
    await observe.until(s => s.events.some(e => e.event === 'telemetry' && e.status === 'recorded')); assert.equal(samples[0].input.cpu.status, 'unknown'); assert.equal(samples[0].input.cpu.usagePercent, null);
    const first = (await f.call(n.path, { token: n.token })).json(); assert.equal(first.freshness, 'fresh'); assert.equal(first.sample.cpu.reason, 'warming-up'); assert.equal(first.sample.sampleVersion, 4); assert.equal(first.sample.memory.status, 'available');
    assert.deepEqual(first.sample.memory, samples[0].input.memory); assert.deepEqual(first.sample.disk, samples[0].input.disk);
    assert.equal(first.sample.network.reason, 'warming-up'); assert.deepEqual(first.sample.network, samples[0].input.network);
    assert.equal(first.sample.disk.scope, 'linux-mount-namespace'); assert.ok(['available', 'partial', 'unavailable'].includes(first.sample.disk.status));
    await observe.until(s => s.requests.filter(r => r.url.includes('/telemetry/') && r.url.endsWith('/sample')).length === 2);
    const deadline = Date.now() + 5000; while (samples.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(samples.length, 2);
    const latest = (await f.call(n.path, { token: n.token })).json();
    assert.equal(latest.sample.cpu.status, 'available'); assert.ok(latest.sample.cpu.intervalMs >= 30000); assert.ok(latest.sample.cpu.usagePercent >= 0 && latest.sample.cpu.usagePercent <= 100);
    assert.ok(samples[1].at - samples[0].at >= 30000); assert.equal(latest.sample.receivedAt, samples[1].result.result.sample.receivedAt); assert.equal(latest.sample.sampleVersion, 4); assert.deepEqual(latest.sample.memory, samples[1].input.memory); assert.equal(latest.sample.memory.status, 'available'); assert.deepEqual(latest.sample.disk, samples[1].input.disk);
    assert.equal(execute.requests.some(r => r.url.includes('/telemetry/')), false);
    assert.deepEqual(latest.sample.network, samples[1].input.network); assert.equal(latest.sample.network.status, 'available'); assert.ok(latest.sample.network.intervalMs >= 30000); assert.ok(latest.sample.network.interfaces.length > 0);
    const credential = readFileSync(join(installed.observe, 'credential.json')); observe.child.kill('SIGTERM'); await observe.until(s => s.events.some(e => e.event === 'stopping'));
    assert.equal(observe.closed, false); release(); await observe.until(s => s.closed); assert.equal(observe.code, 0, observe.stderr); await execute.stop();
    assert.equal(observe.requests.filter(r => r.url.includes('/telemetry/') && r.url.endsWith('/sample')).length, 2);
    assert.deepEqual(readFileSync(join(installed.observe, 'credential.json')), credential); assert.equal(existsSync(join(installed.observe, 'state/ledger.json')), false); assert.equal(existsSync(join(installed.observe, 'state/daemon.lock')), false);
    assert.equal((await f.call(n.path.replace('/telemetry', '/probe'), { token: n.token })).json().jobs.length, 0);
    console.log(JSON.stringify({ installedFormat: 'springbok-control-node/v7', uploadIntervalMs: samples[1].at - samples[0].at, sampleVersion: latest.sample.sampleVersion, cpu: latest.sample.cpu, memory: latest.sample.memory, disk: latest.sample.disk, network: latest.sample.network, receivedAt: latest.sample.receivedAt, executeTelemetryRequests: 0, gracefulDrain: true, executionReady: false }));
  } finally { release?.(); for (const c of children) await c.dispose(); await f.close(); rmSync(p.directory, { recursive: true, force: true }); }
});
