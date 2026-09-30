import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { openStore, replay, candidate, requireSupportedPlatform } from '../src/demo/store.mjs';
import { startDemo } from '../src/demo/server.mjs';
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'springbok-demo-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const row = (store, service = 'gateway') => store.snapshot().services.find(r => r.spec.id === service);
const action = (store, action, extra = {}, service = 'gateway') => store.action(store.snapshot().revision, { service, action, ...extra });
function approve(store, service = 'gateway') { return action(store, 'approve', { binding: store.snapshot().bindings[service], acknowledged: true }, service); }
function release(store, service = 'gateway') { action(store, 'test', { success: true }, service); approve(store, service); action(store, 'promote', { success: true }, service); }

test('demo v1/v2 promotion and rollback persist through replay for four independent services', t => {
  const dir = directory(t); let store = openStore(dir);
  for (const service of ['gateway', 'forum', 'game', 'account']) {
    release(store, service); action(store, 'candidate', { version: 'v2' }, service); release(store, service);
    action(store, 'rollback', { success: true }, service);
    assert.equal(row(store, service).active.artifact, candidate(service, 'v1').artifact);
    assert.deepEqual(store.snapshot().demoVersions[service], { candidate: 'v1', active: 'v1' });
  }
  const before = store.snapshot(); store.close(); store = openStore(dir);
  assert.deepEqual(store.snapshot(), before); store.close();
});
test('restart durably invalidates only unconsumed approvals; repeated restart is idempotent', t => {
  const dir = directory(t); let store = openStore(dir);
  release(store, 'forum'); action(store, 'test', { success: true }); approve(store);
  const before = store.snapshot(); store.close(); store = openStore(dir);
  assert.equal(row(store).phase, 'tested'); assert.equal(row(store).approval, null);
  assert.equal(row(store, 'forum').phase, 'live');
  assert.equal(store.snapshot().revision, before.revision + 1);
  assert.equal(store.snapshot().history.at(-1).kind, 'restart');
  assert.throws(() => action(store, 'promote', { success: true }));
  const recovered = store.snapshot(); store.close(); store = openStore(dir);
  assert.deepEqual(store.snapshot(), recovered);
  approve(store); action(store, 'promote', { success: true }); store.close(); store = openStore(dir);
  assert.equal(row(store).phase, 'live'); store.close();
});
test('recovery preserves consumed approvals across multiple interleaved invalidations', t => {
  const dir = directory(t); let store = openStore(dir);
  for (const service of ['gateway', 'account']) { action(store, 'test', { success: true }, service); approve(store, service); }
  store.close(); store = openStore(dir); approve(store); action(store, 'promote', { success: true }); approve(store, 'account');
  store.close(); store = openStore(dir);
  assert.equal(row(store).phase, 'live'); assert.equal(row(store, 'account').phase, 'tested');
  approve(store, 'account'); action(store, 'promote', { success: true }, 'account');
  store.close(); store = openStore(dir); assert.equal(row(store, 'account').phase, 'live'); store.close();
});
test('candidate changes and failed tests cannot retain simulated approval; failures are not success', t => {
  const store = openStore(directory(t)); t.after(() => store.close());
  action(store, 'test', { success: true }); approve(store); action(store, 'candidate', { version: 'v2' });
  assert.equal(row(store).approval, null); assert.throws(() => action(store, 'promote', { success: true }));
  action(store, 'test', { success: false }); assert.equal(row(store).phase, 'test-failed'); assert.throws(() => approve(store));
  action(store, 'test', { success: true }); approve(store); action(store, 'promote', { success: false });
  assert.equal(row(store).phase, 'production-failed'); assert.equal(row(store).active, null); assert.throws(() => action(store, 'rollback', { success: true }));
});
test('failed rollback preserves its exact known-good target until a successful retry', t => {
  const store = openStore(directory(t)); t.after(() => store.close());
  release(store); action(store, 'candidate', { version: 'v2' }); release(store);
  action(store, 'rollback', { success: false }); assert.equal(row(store).phase, 'rollback-failed');
  assert.equal(row(store).active.artifact, candidate('gateway', 'v2').artifact);
  action(store, 'rollback', { success: true }); assert.equal(row(store).active.artifact, candidate('gateway', 'v1').artifact);
});
test('invalid actor, execution escapes, binding, acknowledgement and stale revisions never mutate history', t => {
  const store = openStore(directory(t)); t.after(() => store.close());
  action(store, 'test', { success: true }); const before = store.snapshot();
  for (const input of [
    { service: 'gateway', action: 'approve', acknowledged: true, binding: 'wrong' },
    { service: 'gateway', action: 'approve', acknowledged: false, binding: before.bindings.gateway },
    { service: 'gateway', action: 'test', success: true, actor: { role: 'human' } },
    { service: 'gateway', action: 'shell', command: 'arbitrary' },
    { service: 'gateway', action: 'candidate', version: 'https://example.com' },
    { service: 'other', action: 'test', success: true },
  ]) assert.throws(() => store.action(before.revision, input));
  assert.throws(() => store.action(0, { service: 'gateway', action: 'test', success: true }), /State changed/);
  assert.deepEqual(store.snapshot(), before);
});
test('corrupted or semantically invalid ledger fails closed without overwriting it', t => {
  const dir = directory(t); const file = join(dir, 'ledger.json');
  for (const bad of ['{', JSON.stringify({ version: 2, mode: 'demo-only', events: [] }), JSON.stringify({ version: 1, mode: 'demo-only', events: [{ revision: 1, kind: 'restart', invalidated: [42] }] })]) {
    writeFileSync(file, bad); assert.throws(() => openStore(dir)); assert.equal(readFileSync(file, 'utf8'), bad);
    assert.equal(existsSync(join(dir, 'owner.lock')), false);
  }
  assert.throws(() => replay([{ revision: 7, kind: 'action', input: {} }]));
});
test('exclusive lock and symlink defenses fail closed without changing foreign data', t => {
  const dir = directory(t); const store = openStore(dir); assert.throws(() => openStore(dir), /locked/); store.close();
  const foreign = join(directory(t), 'foreign.json'); writeFileSync(foreign, 'untouched');
  rmSync(join(dir, 'ledger.json')); symlinkSync(foreign, join(dir, 'ledger.json'));
  assert.throws(() => openStore(dir)); assert.equal(readFileSync(foreign, 'utf8'), 'untouched');
  const link = join(directory(t), 'linked'); symlinkSync(dir, link); assert.throws(() => openStore(link), /real directory/);
});
test('a write failure poisons the process and never reports success or changes the old ledger', t => {
  const dir = directory(t); const seed = openStore(dir); seed.close(); const original = readFileSync(join(dir, 'ledger.json'), 'utf8');
  const store = openStore(dir, { writeFile() { throw new Error('disk failure'); } }); t.after(() => store.close());
  assert.throws(() => action(store, 'test', { success: true }), /write failed/);
  assert.throws(() => store.snapshot(), /unavailable/); assert.equal(readFileSync(join(dir, 'ledger.json'), 'utf8'), original);
});
test('failed approval invalidation cannot expose a still-approved store', t => {
  const dir = directory(t); const store = openStore(dir); action(store, 'test', { success: true }); approve(store); store.close();
  assert.throws(() => openStore(dir, { writeFile() { throw new Error('disk failure'); } }), /write failed/);
  const recovered = openStore(dir); assert.equal(row(recovered).phase, 'tested'); recovered.close();
});
function request(origin, { method = 'GET', path = '/api/state', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + path, { method, headers, agent: false }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    }); req.on('error', reject); req.end(body);
  });
}
test('HTTP loopback host/origin/CSRF, size, route and stale-request protections', async t => {
  const app = await startDemo({ directory: directory(t), port: 0 }); t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  const get = await request(app.origin); const state = JSON.parse(get.text);
  assert.equal(get.status, 200); assert.equal(get.headers['cache-control'], 'no-store');
  assert.match(get.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(get.headers['access-control-allow-origin'], undefined); assert.equal(get.headers['set-cookie'], undefined);
  const body = JSON.stringify({ revision: 0, service: 'gateway', action: 'test', success: true });
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf };
  for (const change of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-CSRF-Token': 'bad' }, { Origin: '' }, { 'Content-Type': 'text/plain' }]) {
    assert.equal((await request(app.origin, { method: 'POST', path: '/api/action', headers: { ...headers, ...change }, body })).status, 403);
  }
  assert.equal((await request(app.origin, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await request(app.origin, { headers: { Origin: 'https://evil.example' } })).status, 403);
  for (const path of ['/../ledger.json', '/.springbok-demo/ledger.json', '/api/action', '/app.js?file=secret']) assert.equal((await request(app.origin, { path })).status, 404);
  assert.equal((await request(app.origin, { method: 'POST', path: '/api/action', headers, body: 'x'.repeat(2049) })).status, 413);
  assert.equal((await request(app.origin, { method: 'POST', path: '/api/action', headers, body })).status, 200);
  assert.equal((await request(app.origin, { method: 'POST', path: '/api/action', headers, body })).status, 409);
  assert.equal(JSON.parse((await request(app.origin)).text).revision, 1);
});
test('session token rotates on restart and is never stored with demo history', async t => {
  const dir = directory(t); let app = await startDemo({ directory: dir, port: 0 });
  const first = JSON.parse((await request(app.origin)).text); await app.close();
  app = await startDemo({ directory: dir, port: 0 }); t.after(() => app.close());
  const second = JSON.parse((await request(app.origin)).text); assert.notEqual(first.csrf, second.csrf);
  const disk = readFileSync(join(dir, 'ledger.json'), 'utf8'); assert.ok(!disk.includes(first.csrf) && !disk.includes(second.csrf));
  assert.equal((await request(app.origin, { method: 'POST', path: '/api/action', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': first.csrf }, body: '{}' })).status, 403);
});

test('unsupported platforms are explicitly rejected before opening demo storage', () => {
  assert.doesNotThrow(() => requireSupportedPlatform('linux'));
  for (const platform of ['win32', 'darwin']) assert.throws(() => requireSupportedPlatform(platform), { code: 'UNSUPPORTED_PLATFORM' });
});
