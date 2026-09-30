import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoordinator } from '../src/execution/coordinator.mjs';
import { catalog, fakeBackend, input, ai, human, row } from './helpers/execution.mjs';

// Test-only HTTP transport. No login, credential, user URL or real Komodo server.
async function fixture(t, options = {}) {
  const data = catalog(), backend = fakeBackend(data.releases);
  const directory = mkdtempSync(join(tmpdir(), 'springbok-execution-http-'));
  const wire = [], modes = new Map();
  const allowed = new Set(['read/GetDeployment', 'read/GetUpdate', 'read/InspectDeploymentContainer', 'execute/Deploy']);
  const server = http.createServer(async (req, res) => {
    const path = req.url.slice(1);
    try {
      assert.equal(req.method, 'POST'); assert.ok(allowed.has(path));
      assert.equal(req.headers.authorization, undefined);
      let body = '';
      for await (const chunk of req) { body += chunk; assert.ok(body.length < 2048); }
      const params = JSON.parse(body); wire.push({ path, params });
      const mode = modes.get(path);
      if (mode === 'unavailable') { res.writeHead(503); res.end('private backend failure'); return; }
      if (mode === 'redirect') { res.writeHead(307, { location: '/forbidden' }); res.end(); return; }
      const result = await backend.call(path, params);
      if (mode === 'drop') { req.socket.destroy(); return; }
      if (mode === 'hang') return;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end('invalid fixture request'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = { async call(path, params, { signal }) {
    assert.ok(allowed.has(path));
    const response = await fetch(`${origin}/${path}`, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    if (!response.ok) throw new Error('fixture HTTP request failed');
    return response.json();
  } };
  const settings = { directory, ...data, transport, ...options };
  let coordinator = openCoordinator(settings);
  t.after(async () => {
    coordinator.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  });
  return { backend, wire, modes, directory, get coordinator() { return coordinator; },
    restart() { coordinator.close(); coordinator = openCoordinator(settings); return coordinator; } };
}

test('HTTP fixture round-trip binds serialized deployment/update evidence through approval and production', async t => {
  const f = await fixture(t), c = f.coordinator;
  const pending = await c.submit(input('test-http', 'test'), ai);
  assert.equal(pending.status, 'accepted'); assert.equal(row(c).phase, 'testing');
  await c.reconcile('test-http'); assert.equal(row(c).phase, 'tested');
  await c.submit(input('approve-http', 'approve', { binding: c.snapshot().bindings.gateway }), human);
  await c.submit(input('promote-http', 'promote'), ai); await c.reconcile('promote-http');
  assert.equal(row(c).phase, 'live'); assert.equal(f.backend.executeCount, 2);
  const previous = c.snapshot(); assert.deepEqual(f.restart().snapshot(), previous);
  for (const call of f.wire) assert.deepEqual(Object.keys(call.params), [call.path === 'read/GetUpdate' ? 'id' : 'deployment']);
});

test('HTTP accepted-but-disconnected request stays unknown without automatic fetch or caller retries', async t => {
  const f = await fixture(t); f.modes.set('execute/Deploy', 'drop');
  const request = input('dropped-http', 'test');
  assert.equal((await f.coordinator.submit(request, ai)).status, 'unknown');
  assert.equal(f.backend.executeCount, 1); f.restart();
  assert.equal((await f.coordinator.submit(request, ai)).status, 'unknown');
  await assert.rejects(f.coordinator.reconcile(request.id), /resubmission is forbidden/);
  await assert.rejects(f.coordinator.submit(input('fresh-http', 'test'), ai), /not allowed/);
  assert.equal(f.wire.filter(c => c.path === 'execute/Deploy').length, 1);
});

test('HTTP timeout remains unknown even when the fixture accepted the request', async t => {
  const f = await fixture(t, { timeoutMs: 500 }); f.modes.set('execute/Deploy', 'hang');
  assert.equal((await f.coordinator.submit(input('timeout-http', 'test'), ai)).status, 'unknown');
  assert.equal(f.backend.executeCount, 1);
  f.restart(); assert.equal((await f.coordinator.submit(input('timeout-http', 'test'), ai)).status, 'unknown');
  assert.equal(f.backend.executeCount, 1);
});

test('HTTP read failure can retry only the known ID; backend body is not persisted or returned', async t => {
  const f = await fixture(t); await f.coordinator.submit(input('read-http', 'test'), ai);
  f.modes.set('read/GetUpdate', 'unavailable');
  await assert.rejects(f.coordinator.reconcile('read-http'), /^Error: execution transport unavailable or timed out$/);
  assert.equal(f.coordinator.snapshot().requests[0].status, 'accepted');
  assert.doesNotMatch(readFileSync(join(f.directory, 'ledger.json'), 'utf8'), /private backend/);
  f.restart(); f.modes.delete('read/GetUpdate');
  assert.equal((await f.coordinator.reconcile('read-http')).status, 'succeeded');
  assert.equal(f.backend.executeCount, 1);
});

test('HTTP redirects fail closed before intent and do not reach an arbitrary endpoint', async t => {
  const f = await fixture(t); f.modes.set('read/GetDeployment', 'redirect');
  await assert.rejects(f.coordinator.submit(input('redirect-http', 'test'), ai), /unavailable/);
  assert.equal(f.coordinator.snapshot().history.length, 0); assert.equal(f.backend.executeCount, 0);
  assert.deepEqual(f.wire.map(c => c.path), ['read/GetDeployment']);
});
