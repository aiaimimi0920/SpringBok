import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestController } from '../src/test-console/controller.mjs';
import { startTestConsole } from '../src/test-console/server.mjs';
import { loopbackClient } from '../src/test-console/transport.mjs';
import { catalog, fakeBackend, image } from './helpers/execution.mjs';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-console-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = catalog();
  data.releases.push(...data.releases.slice(0, 4).map(r => { const next = structuredClone(r); next.artifact = image(3); for (const role of ['test', 'production']) next[role].config.image.params.image = image(3); return next; }));
  const backend = fakeBackend(data.releases);
  let hook;
  backend.hook = async (path, params, options) => {
    if (hook) { const value = await hook(path, params, options); if (value !== undefined) return value; }
    if (path === 'write/UpdateDeployment') { const resource = backend.resources.get(params.id); resource.config = structuredClone(params.config); return structuredClone(resource); }
  };
  const options = { directory, ...data, versions: { v1: image(1), v2: image(2), bad: image(3) }, transport: backend, timeoutMs: 100 };
  let controller = openTestController(options), count = 0;
  t.after(() => controller.close());
  return { directory, backend, options, get c() { return controller; }, set hook(fn) { hook = fn; },
    async action(operation, extra = {}, service = 'gateway') {
      const body = { revision: controller.snapshot().revision, id: `r${++count}`, service, operation, ...extra };
      if (['test', 'promote', 'rollback'].includes(operation)) body.confirmation = controller.preview(body).confirmation;
      return controller.action(body);
    },
    restart() { controller.close(); controller = openTestController(options); },
  };
}
async function execute(f, operation, service = 'gateway') { const r = await f.action(operation, {}, service); return f.c.reconcile(r.input.id); }
async function accept(f, service = 'gateway') { return f.action('approve', { binding: f.c.snapshot().bindings[service], acknowledged: true }, service); }
async function release(f, service) { await execute(f, 'test', service); await accept(f, service); await execute(f, 'promote', service); }
const row = (f, service = 'gateway') => f.c.snapshot().services.find(r => r.spec.id === service);

test('console stages fixed configs then runs four-service v1/v2/rollback through durable coordinator', async t => {
  const f = setup(t);
  for (const service of ['gateway', 'forum', 'game', 'account']) {
    await release(f, service); await f.action('candidate', { version: 'v2' }, service); await release(f, service); await execute(f, 'rollback', service);
    assert.equal(row(f, service).active.artifact, image(1));
  }
  assert.equal(f.backend.executeCount, 20);
  assert.equal(f.c.snapshot().preparationHistory.filter(r => r.kind === 'prepare').length, 20);
  const snapshot = f.c.snapshot(); f.restart(); assert.deepEqual(f.c.snapshot(), snapshot);
});
test('configuration intent is durable before write, and exact full config is verified before deploy', async t => {
  const f = setup(t); let observed = false;
  f.hook = async path => {
    if (path === 'write/UpdateDeployment') {
      const file = JSON.parse(readFileSync(join(f.directory, 'preparation/ledger.json')));
      assert.equal(file.events.at(-1).kind, 'prepare'); assert.equal(f.backend.executeCount, 0); observed = true;
    }
  };
  await execute(f, 'test'); assert.equal(observed, true);
});
test('lost configuration receipt remains blocked across restart and cannot automatically write or deploy again', async t => {
  const f = setup(t); let writes = 0;
  f.hook = async path => { if (path === 'write/UpdateDeployment') { writes++; throw new Error('lost write receipt'); } };
  const result = await f.action('test'); assert.equal(result.status, 'preparation-unknown');
  assert.equal(f.backend.executeCount, 0); f.restart();
  await assert.rejects(f.action('test'), /preparation unknown/); await assert.rejects(f.action('candidate', { version: 'v2' }), /preparation unknown/);
  assert.equal(writes, 1); assert.equal(f.backend.executeCount, 0);
});
test('invalid approval/phase/arbitrary fields cannot stage configuration', async t => {
  const f = setup(t);
  await assert.rejects(f.action('promote')); await assert.rejects(f.action('test', { success: true }));
  await assert.rejects(f.action('candidate', { version: 'https://example.com' }));
  assert.equal(f.c.snapshot().preparationHistory.length, 0); assert.equal(f.backend.executeCount, 0);
});
test('successful Update with exact non-OOM exit1 produces a distinct durable health-failure and blocks acceptance', async t => {
  const f = setup(t);
  await f.action('candidate', { version: 'bad' });
  f.hook = async path => path === 'read/InspectDeploymentContainer' ? { Image: image(3), State: { Status: 'exited', Running: false, OOMKilled: false, Paused: false, ExitCode: 1 } } : undefined;
  const result = await execute(f, 'test'); assert.equal(result.status, 'failed'); assert.equal(result.failure, 'container-exited-1');
  const evidence = f.c.snapshot().history.at(-1); assert.equal(evidence.kind, 'health-failure'); assert.equal(evidence.evidence.updateSuccess, true);
  await assert.rejects(accept(f)); await assert.rejects(f.action('promote'));
  f.restart(); assert.equal(row(f).phase, 'test-failed');
});
test('OOM/paused/wrong image/missing exit evidence do not become confirmed fixture failure', async t => {
  const f = setup(t); const request = await f.action('test');
  for (const change of [{ OOMKilled: true }, { Paused: true }, { ExitCode: 137 }, { ExitCode: undefined }, { Running: true }]) {
    f.hook = async path => path === 'read/InspectDeploymentContainer' ? { Image: image(1), State: { Status: 'exited', Running: false, OOMKilled: false, Paused: false, ExitCode: 1, ...change } } : undefined;
    await assert.rejects(f.c.reconcile(request.input.id)); assert.equal(row(f).phase, 'testing');
  }
});
test('known Update survives restart without another config write/Deploy; unused acceptance revoked', async t => {
  const f = setup(t); const request = await f.action('test'); const before = f.backend.calls.length;
  f.restart(); await f.c.reconcile(request.input.id); assert.equal(f.backend.executeCount, 1);
  assert.ok(f.backend.calls.slice(before).every(c => c.path.startsWith('read/')));
  await accept(f); f.restart(); assert.equal(row(f).phase, 'tested'); await assert.rejects(f.action('promote'));
});
test('unknown execution and stale revision cannot bypass deployment gate', async t => {
  const f = setup(t); const revision = f.c.snapshot().revision;
  f.hook = async path => { if (path === 'execute/Deploy') throw new Error('lost result'); };
  const request = await f.action('test'); assert.equal(request.status, 'unknown'); f.restart();
  await assert.rejects(f.action('test'));
  await assert.rejects(f.c.action({ revision, id: 'old', service: 'gateway', operation: 'test' }), /stale/);
});
test('tampered preparation plan fails replay without overwriting history', async t => {
  const f = setup(t); await execute(f, 'test'); f.c.close();
  const path = join(f.directory, 'preparation/ledger.json'); const saved = JSON.parse(readFileSync(path));
  saved.events[0].plan.service = 'forum'; const bytes = JSON.stringify(saved); writeFileSync(path, bytes);
  assert.throws(() => openTestController(f.options), /plan mismatch/); assert.equal(readFileSync(path, 'utf8'), bytes);
});
test('real-test HTTP rejects wrong Host/Origin/CSRF, caller results and arbitrary routes', async t => {
  const f = setup(t), app = await startTestConsole({ controller: f.c }); t.after(() => app.close());
  const first = await fetch(`${app.origin}/api/state`); const state = await first.json();
  assert.equal(state.mode, 'disposable-integration-test');
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf };
  const request = { revision: state.revision, id: 'http-test', service: 'gateway', operation: 'test' };
  const body = JSON.stringify({ ...request, confirmation: f.c.preview(request).confirmation });
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get(app.origin + '/api/state', { headers: { Host: 'other.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  for (const change of [{ Origin: 'https://other.example' }, { 'X-CSRF-Token': 'bad' }, { Origin: '' }]) {
    assert.equal((await fetch(`${app.origin}/api/action`, { method: 'POST', headers: { ...headers, ...change }, body })).status, 403);
  }
  assert.equal((await fetch(`${app.origin}/api/action`, { method: 'POST', headers, body: body.slice(0, -1) + ',"success":true}' })).status, 400);
  assert.equal((await fetch(`${app.origin}/api/action`, { method: 'POST', headers, body })).status, 200);
  assert.equal((await fetch(`${app.origin}/api/action`, { method: 'POST', headers, body })).status, 409);
  assert.equal((await fetch(`${app.origin}/ledger.json`)).status, 404);
});
test('test transport only accepts numeric high loopback port and requires an explicit login', async () => {
  for (const port of [80, 65536, '9120', 'https://example.com']) assert.throws(() => loopbackClient(port));
  await assert.rejects(loopbackClient(9120).call('execute/Deploy', {}), /not allowed/);
});

test('temporary Core bridge accepts private literal IPv4 only and listens only on loopback', async () => {
  const { openCoreBridge, validateCoreAddress } = await import('../scripts/test-console/core-bridge.mjs');
  for (const value of ['example.com', '127.0.0.1', '0.0.0.0', '8.8.8.8', '::1', '172.99.1.1']) assert.throws(() => validateCoreAddress(value));
  const bridge = await openCoreBridge('172.18.0.2');
  assert.equal(bridge.address, '127.0.0.1'); assert.ok(bridge.port > 1023); await bridge.close();
});

test('Mongo diagnostic outputs only fixed categories and numeric IDs, never raw log fields', async () => {
  const { runInNewContext } = await import('node:vm');
  const script = readFileSync(new URL('../scripts/test-console/mongo-diagnostic.cjs', import.meta.url), 'utf8');
  const secret = 'SENSITIVE_TEST_MARKER';
  const log = Buffer.from(JSON.stringify({ s: 'E', id: 20568, msg: 'Error setting up listener', attr: { error: `Address already in use ${secret}` } }) + '\n' + JSON.stringify({ s: 'I', id: 999, msg: 'Permission denied ' + secret }));
  let output = '';
  const fs = { existsSync: path => path !== '/data/db/docker-initdb.log', openSync: () => 1, fstatSync: () => ({ size: log.length }),
    readSync: (_fd, buffer) => log.copy(buffer), closeSync() {}, readFileSync: () => '48' };
  runInNewContext(script, { require: () => fs, Buffer, print: text => output = text });
  assert.match(output, /exit=48 fatal_count=1 categories=ADDRESS_IN_USE,LISTENER ids=20568/);
  assert.ok(!output.includes(secret)); assert.ok(!output.includes('PERMISSION'));
});

test('M6 privileged integration has only an acknowledged exact-main-SHA manual entry', () => {
  const wf = readFileSync(new URL('../.github/workflows/test-console-integration.yml', import.meta.url), 'utf8');
  assert.match(wf, /workflow_dispatch:/); assert.doesNotMatch(wf, /\n  (push|pull_request|pull_request_target|schedule):/);
  assert.match(wf, /github\.ref == 'refs\/heads\/main'/); assert.match(wf, /inputs\.approve_temporary_docker_admin/);
  assert.match(wf, /default: false/); assert.match(wf, /"\$REVIEWED_SHA" == "\$GITHUB_SHA"/);
  assert.ok(wf.indexOf('"$REVIEWED_SHA" == "$GITHUB_SHA"') < wf.indexOf('uses: actions/checkout'));
  assert.doesNotMatch(wf, /secrets\.|contents: write/);
});
test('unchanged M6 inputs retain their evidence hashes; M7 changes are explicitly excluded from that claim', async () => {
  const { createHash } = await import('node:crypto');
  const evidence = JSON.parse(readFileSync(new URL('../docs/test-console-evidence.json', import.meta.url)));
  const evolution = JSON.parse(readFileSync(new URL('../docs/m7-changed-inputs.json', import.meta.url)));
  assert.equal(evolution.baseline_commit, evidence.source_commit);
  for (const [path, hash] of Object.entries(evidence.execution_files_sha256)) {
    if (evolution.changed_inputs.includes(path)) continue;
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex'), hash, path);
  }
});

test('review is read-only and binds exact resource, artifact, revision and request', async t => {
  const f = setup(t), before = f.c.snapshot();
  const body = { revision: before.revision, id: 'review-test', service: 'gateway', operation: 'test' };
  const review = f.c.preview(body);
  assert.deepEqual(f.c.snapshot(), before); assert.deepEqual(f.backend.calls, []);
  assert.equal(review.plan.target, f.options.releases[0].test.id);
  assert.equal(review.plan.artifact, image(1));
  await assert.rejects(f.c.action(body));
  for (const change of [{ id: 'other' }, { service: 'forum' }, { operation: 'promote' },
    { confirmation: { ...review.confirmation, signature: '0'.repeat(64) } },
    { confirmation: { ...review.confirmation, expiresAt: 0 } }]) {
    await assert.rejects(f.c.action({ ...body, confirmation: review.confirmation, ...change }));
  }
  assert.deepEqual(f.c.snapshot(), before); assert.deepEqual(f.backend.calls, []);
  await f.c.action({ ...body, confirmation: review.confirmation }); assert.equal(f.backend.executeCount, 1);
});
test('old revision, restart and repeated confirmation cannot send another deployment', async t => {
  const f = setup(t);
  const body = { revision: f.c.snapshot().revision, id: 'review-old', service: 'gateway', operation: 'test' };
  const review = f.c.preview(body); f.restart();
  await assert.rejects(f.c.action({ ...body, confirmation: review.confirmation }), /confirmation/);
  assert.equal(f.backend.calls.length, 0);
  const current = f.c.preview(body);
  const results = await Promise.allSettled([f.c.action({ ...body, confirmation: current.confirmation }), f.c.action({ ...body, confirmation: current.confirmation })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.backend.executeCount, 1);
  await assert.rejects(f.c.action({ ...body, confirmation: current.confirmation }), /stale/);
});
test('candidate changes invalidate the preview; rollback review uses the known-good image', async t => {
  const f = setup(t);
  const body = { revision: f.c.snapshot().revision, id: 'old-candidate', service: 'gateway', operation: 'test' };
  const review = f.c.preview(body);
  await f.action('candidate', { version: 'v2' });
  await assert.rejects(f.c.action({ ...body, confirmation: review.confirmation }), /stale/);
  assert.equal(f.backend.executeCount, 0);
  await release(f, 'gateway'); await f.action('candidate', { version: 'v1' }); await release(f, 'gateway');
  const rollback = f.c.preview({ revision: f.c.snapshot().revision, id: 'rollback-review', service: 'gateway', operation: 'rollback' });
  assert.equal(rollback.plan.artifact, image(2)); assert.equal(rollback.plan.target, f.options.releases[0].production.id);
});
test('HTTP preview is protected and cannot mutate or accept caller-supplied plans', async t => {
  const f = setup(t), app = await startTestConsole({ controller: f.c }); t.after(() => app.close());
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf };
  const body = { revision: state.revision, id: 'preview-http', service: 'gateway', operation: 'test' };
  assert.equal((await fetch(`${app.origin}/api/preview`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify(body) })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/preview`, { method: 'POST', headers, body: JSON.stringify({ ...body, plan: {} }) })).status, 400);
  const response = await fetch(`${app.origin}/api/preview`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200); assert.equal((await response.json()).plan.artifact, image(1));
  assert.equal(f.backend.calls.length, 0); assert.deepEqual(f.c.snapshot().history, []);
});

test('a genuinely expired signed plan is rejected and confirmation material is never persisted', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const f = setup(t), body = { revision: f.c.snapshot().revision, id: 'expiring', service: 'gateway', operation: 'test' };
  const review = f.c.preview(body);
  t.mock.timers.tick(120001);
  await assert.rejects(f.c.action({ ...body, confirmation: review.confirmation }), /confirmation/);
  assert.equal(f.backend.calls.length, 0);
  const fresh = f.c.preview(body); await f.c.action({ ...body, confirmation: fresh.confirmation });
  for (const folder of ['preparation', 'execution']) {
    const bytes = readFileSync(join(f.directory, folder, 'ledger.json'), 'utf8');
    assert.ok(!bytes.includes(fresh.confirmation.signature)); assert.ok(!bytes.includes('confirmationKey'));
  }
});
