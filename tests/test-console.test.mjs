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

test('privileged integration has only an acknowledged exact-main-SHA manual entry', () => {
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
  const evolution = JSON.parse(readFileSync(new URL('../docs/test-console-evolution.json', import.meta.url)));
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

test('execution inspection distinguishes queued/running/completed evidence without writes or acceptance', async t => {
  const f = setup(t), request = await f.action('test');
  const before = f.c.snapshot(), bytes = readFileSync(join(f.directory, 'execution/ledger.json'), 'utf8');
  const inspect = () => f.c.inspect({ revision: before.revision, id: request.input.id });
  const update = f.backend.updates.get(request.updateId);
  for (const [status, code] of [['Queued', 'queued'], ['InProgress', 'running'], ['Complete', 'ready-to-record']]) {
    update.status = status; assert.equal((await inspect()).code, code);
  }
  update.success = false; assert.equal((await inspect()).code, 'update-failed'); update.success = true;
  update.target.id = 'f'.repeat(24); assert.equal((await inspect()).code, 'update-mismatch');
  assert.deepEqual(f.c.snapshot(), before); assert.equal(readFileSync(join(f.directory, 'execution/ledger.json'), 'utf8'), bytes);
  assert.equal(f.backend.executeCount, 1); await assert.rejects(accept(f));
});
test('execution inspection classifies only exact container evidence, never leaks raw fields', async t => {
  const f = setup(t), request = await f.action('test'), before = f.c.snapshot();
  const inspect = () => f.c.inspect({ revision: before.revision, id: request.input.id });
  const healthy = { Status: 'running', Running: true, Paused: false, OOMKilled: false, Health: { Status: 'healthy' } };
  for (const [change, code] of [
    [{ OOMKilled: true }, 'oom'], [{ Paused: true }, 'paused'],
    [{ Health: { Status: 'starting' } }, 'health-starting'], [{ Health: { Status: 'unhealthy' } }, 'health-unhealthy'],
    [{ Health: null }, 'health-unconfirmed'],
    [{ Status: 'exited', Running: false, ExitCode: 1 }, 'fixture-failed'],
    [{ Status: 'exited', Running: false, ExitCode: 137 }, 'health-unconfirmed'],
  ]) {
    f.hook = async path => path === 'read/InspectDeploymentContainer' ? { Image: image(1), State: { ...healthy, ...change }, Log: 'PRIVATE_BACKEND_MARKER' } : undefined;
    const result = await inspect(); assert.equal(result.code, code); assert.ok(!JSON.stringify(result).includes('PRIVATE_BACKEND_MARKER'));
  }
  f.hook = async path => path === 'read/InspectDeploymentContainer' ? { Image: image(2), State: healthy } : undefined;
  assert.equal((await inspect()).code, 'image-mismatch');
  f.backend.resources.get(request.plan.target).config.command = 'PRIVATE_BACKEND_MARKER';
  const drift = await inspect(); assert.equal(drift.code, 'configuration-drift'); assert.ok(!JSON.stringify(drift).includes('PRIVATE_BACKEND_MARKER'));
  assert.deepEqual(f.c.snapshot(), before); assert.equal(f.backend.executeCount, 1);
});
test('inspection transport failure and timeout remain unconfirmed and reveal no backend error', async t => {
  const f = setup(t), request = await f.action('test'), before = f.c.snapshot();
  f.hook = async () => { throw new Error('PRIVATE_ERROR_MARKER'); };
  let result = await f.c.inspect({ revision: before.revision, id: request.input.id });
  assert.equal(result.code, 'unavailable'); assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR_MARKER'));
  f.hook = async () => new Promise(() => {});
  result = await f.c.inspect({ revision: before.revision, id: request.input.id });
  assert.equal(result.code, 'unavailable'); assert.deepEqual(f.c.snapshot(), before);
});
test('unknown preparation and unknown receipts are explained with zero backend calls and remain blocked', async t => {
  const f = setup(t);
  f.hook = async path => { if (path === 'write/UpdateDeployment') throw new Error('lost config'); };
  const prep = await f.action('test'), count = f.backend.calls.length;
  const body = { revision: f.c.snapshot().revision, id: prep.input.id };
  assert.equal((await f.c.inspect(body)).code, 'configuration-unknown'); assert.equal(f.backend.calls.length, count);
  f.restart(); assert.equal((await f.c.inspect(body)).code, 'configuration-unknown'); await assert.rejects(f.action('test'));
  f.hook = async path => { if (path === 'execute/Deploy') throw new Error('lost deploy'); };
  const request = await f.action('test', {}, 'forum'), count2 = f.backend.calls.length;
  assert.equal((await f.c.inspect({ revision: f.c.snapshot().revision, id: request.input.id })).code, 'receipt-unknown');
  assert.equal(f.backend.calls.length, count2); await assert.rejects(f.action('test', {}, 'forum'));
});
test('recorded outcomes are labeled historical and inspection rejects arbitrary IDs, URLs and stale revisions', async t => {
  const f = setup(t), request = await f.action('test'); await f.c.reconcile(request.input.id);
  const before = f.c.snapshot(), count = f.backend.calls.length;
  assert.equal((await f.c.inspect({ revision: before.revision, id: request.input.id })).code, 'recorded-success');
  for (const body of [{ revision: before.revision, id: 'https://example.com' }, { revision: 0, id: request.input.id },
    { revision: before.revision, id: request.input.id, target: 'elsewhere' }]) await assert.rejects(f.c.inspect(body));
  assert.equal(f.backend.calls.length, count); assert.deepEqual(f.c.snapshot(), before);
});
test('HTTP inspection requires same-origin CSRF and cannot accept replacement evidence or write history', async t => {
  const f = setup(t), request = await f.action('test'), app = await startTestConsole({ controller: f.c }); t.after(() => app.close());
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf };
  const body = { revision: state.revision, id: request.input.id }, before = f.c.snapshot();
  for (const change of [{ Origin: 'https://other.example' }, { 'X-CSRF-Token': 'wrong' }]) {
    assert.equal((await fetch(`${app.origin}/api/inspect`, { method: 'POST', headers: { ...headers, ...change }, body: JSON.stringify(body) })).status, 403);
  }
  assert.equal((await fetch(`${app.origin}/api/inspect`, { method: 'POST', headers, body: JSON.stringify({ ...body, success: true }) })).status, 400);
  const response = await fetch(`${app.origin}/api/inspect`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200); assert.equal((await response.json()).code, 'ready-to-record');
  assert.deepEqual(f.c.snapshot(), before);
});

test('readiness checks only eight catalog resources and one deduplicated cached server without writes', async t => {
  const f = setup(t), before = f.c.snapshot();
  f.hook = async path => path === 'read/GetServerState' ? { status: 'Ok', privateData: 'PRIVATE_READINESS_MARKER' } : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.c.readiness({ revision: before.revision });
    assert.equal(result.rows.length, 8); assert.equal(result.observation, 'matched');
    assert.equal(result.executionReady, false); assert.equal(result.approvalGranted, false);
    assert.ok(result.rows.every(r => r.resource === 'matched' && r.server === 'cached-ok'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_READINESS_MARKER'));
  }
  assert.equal(f.backend.calls.filter(c => c.path === 'read/GetDeployment').length, 16);
  assert.equal(f.backend.calls.filter(c => c.path === 'read/GetServerState').length, 2);
  assert.ok(f.backend.calls.every(c => c.path.startsWith('read/'))); assert.deepEqual(f.c.snapshot(), before);
});
test('readiness rejects wrong resource identity and unknown full config without probing foreign servers', async t => {
  const f = setup(t), before = f.c.snapshot();
  const resources = [...f.backend.resources.values()];
  resources[0].name = 'FOREIGN_PRIVATE_NAME';
  resources[1].config.server_id = 'f'.repeat(24);
  resources[2].config.environment = 'PRIVATE_CONFIG_MARKER';
  f.backend.resources.delete(resources[3]._id.$oid);
  f.hook = async path => path === 'read/GetServerState' ? { status: 'Ok' } : undefined;
  const result = await f.c.readiness({ revision: before.revision });
  assert.equal(result.observation, 'attention');
  assert.deepEqual(result.rows.slice(0, 4).map(r => r.resource), ['identity-mismatch', 'configuration-unknown', 'configuration-unknown', 'missing']);
  assert.ok(result.rows.slice(0, 4).every(r => r.serverId === null && r.artifact === null));
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes('FOREIGN'));
  assert.ok(f.backend.calls.filter(c => c.path === 'read/GetServerState').every(c => c.params.server !== 'f'.repeat(24)));
  assert.deepEqual(f.c.snapshot(), before);
});
test('cached server failures and unknown enum values never become ready or expose response fields', async t => {
  const f = setup(t), revision = f.c.snapshot().revision;
  for (const [status, code] of [['NotOk', 'cached-not-ok'], ['Disabled', 'cached-disabled'], ['unexpected', 'unknown'], ['constructor', 'unknown'], ['__proto__', 'unknown']]) {
    f.hook = async path => path === 'read/GetServerState' ? { status, error: 'PRIVATE_SERVER_ERROR' } : undefined;
    const result = await f.c.readiness({ revision }); assert.equal(result.observation, 'attention');
    assert.ok(result.rows.every(r => r.server === code)); assert.equal(result.executionReady, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SERVER_ERROR'));
  }
});
test('readiness preserves unknown execution blocking even when resource and cache reads match', async t => {
  const f = setup(t);
  f.hook = async path => { if (path === 'execute/Deploy') throw new Error('lost receipt'); if (path === 'read/GetServerState') return { status: 'Ok' }; };
  await f.action('test'); const before = f.c.snapshot(), count = f.backend.executeCount;
  const result = await f.c.readiness({ revision: before.revision });
  assert.equal(result.observation, 'attention'); assert.equal(result.executionReady, false);
  assert.ok(result.rows.filter(r => r.service === 'gateway').every(r => r.recordState === 'unknown'));
  assert.deepEqual(f.c.snapshot(), before); assert.equal(f.backend.executeCount, count); await assert.rejects(f.action('test'));
});
test('readiness timeouts are bounded and cancellation stops subsequent reads and releases the lock', async t => {
  const f = setup(t), before = f.c.snapshot();
  f.hook = async () => new Promise(() => {});
  const timed = await f.c.readiness({ revision: before.revision });
  assert.equal(timed.observation, 'attention'); assert.ok(timed.rows.every(r => r.resource === 'timeout'));
  assert.ok(f.backend.calls.length <= 3); assert.deepEqual(f.c.snapshot(), before);
  let started; const entered = new Promise(resolve => { started = resolve; });
  let aborted = false;
  f.hook = async (_path, _params, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }, { once: true }); started(); return new Promise(() => {}); };
  const abort = new AbortController(), count = f.backend.calls.length;
  const checking = f.c.readiness({ revision: before.revision }, { signal: abort.signal }); await entered; abort.abort();
  await assert.rejects(checking, /cancelled/); assert.equal(aborted, true); assert.equal(f.backend.calls.length, count + 1);
  f.hook = async path => path === 'read/GetServerState' ? { status: 'Ok' } : undefined;
  assert.equal((await f.c.readiness({ revision: before.revision })).observation, 'matched');
  assert.deepEqual(f.c.snapshot(), before);
});
test('readiness rejects arbitrary targets and stale state before reads; HTTP preserves origin and CSRF', async t => {
  const f = setup(t), app = await startTestConsole({ controller: f.c }); t.after(() => app.close());
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf };
  for (const body of [{ revision: state.revision, target: 'https://example.com' }, { revision: -1 }]) {
    await assert.rejects(f.c.readiness(body));
  }
  assert.equal((await fetch(`${app.origin}/api/readiness`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify({ revision: state.revision }) })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/readiness`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: JSON.stringify({ revision: state.revision }) })).status, 403);
  assert.equal(f.backend.calls.length, 0);
  f.hook = async path => path === 'read/GetServerState' ? { status: 'Ok' } : undefined;
  const response = await fetch(`${app.origin}/api/readiness`, { method: 'POST', headers, body: JSON.stringify({ revision: state.revision }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).rows.length, 8);
});

test('HTTP readiness disconnect aborts the pending read and prevents later resource requests', async t => {
  const f = setup(t), app = await startTestConsole({ controller: f.c }); t.after(() => app.close());
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  let enteredResolve, abortedResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const aborted = new Promise(resolve => { abortedResolve = resolve; });
  f.hook = async (_path, _params, { signal }) => { signal.addEventListener('abort', abortedResolve, { once: true }); enteredResolve(); return new Promise(() => {}); };
  const abort = new AbortController();
  const response = fetch(`${app.origin}/api/readiness`, { method: 'POST', signal: abort.signal,
    headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ revision: state.revision }) });
  await entered; abort.abort(); await assert.rejects(response);
  let timer;
  try { await Promise.race([aborted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('disconnect did not abort transport')), 1000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(f.backend.calls.length, 1);
  // Let the abort rejection release the controller's exclusive lock.
  await new Promise(resolve => setImmediate(resolve));
  f.hook = async path => path === 'read/GetServerState' ? { status: 'Ok' } : undefined;
  assert.equal((await f.c.readiness({ revision: state.revision })).rows.length, 8);
});

test('M10 harness rejects the old M6 flag before Docker or credential creation', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('bash', ['scripts/test-console/komodo.sh'], { encoding: 'utf8', env: {
    PATH: process.env.PATH, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'aiaimimi0920/SpringBok', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SPRINGBOK_ALLOW_M6_TEST: 'yes',
  } });
  assert.equal(result.status, 2); assert.match(result.stdout, /Requires explicitly approved disposable GitHub runner/);
});

test('M10 successful real-run evidence binds all current execution inputs', async () => {
  const { createHash } = await import('node:crypto');
  const evidence = JSON.parse(readFileSync(new URL('../docs/combined-console-evidence.json', import.meta.url)));
  assert.equal(evidence.source_commit, 'd91d8572dd820b0448c9b106f964478c41a0abc4');
  assert.equal(evidence.run_id, 36903452204);
  assert.equal(Object.keys(evidence.execution_files_sha256).length, 22);
  for (const [path, hash] of Object.entries(evidence.execution_files_sha256)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex'), hash, path);
  }
});
