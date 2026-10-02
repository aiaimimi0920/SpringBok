import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { openProbeBridge } from '../../src/node-bridge/bridge.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'https://control.example.invalid';
const bundle = (await build({ entryPoints: [join(root, 'cloud/worker.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })).outputFiles[0].text;
test('actual workerd / SQLite / Node bridge persists delivery and refuses unsafe replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'springbok-workerd-'));
  const control = randomBytes(32).toString('hex'), node = randomBytes(32).toString('hex');
  const options = { modules: true, script: bundle,
    compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0,
    durableObjects: { TARGET: { className: 'TargetMailbox', useSQLite: true } }, resourcePersistencePath: join(dir, 'cloud'), telemetry: { enabled: false }, cf: false, logRequests: false,
    bindings: { ENABLE_PROTOCOL_TEST: 'yes', CONTROL_TOKEN: control, NODE_TOKEN: node } };
  let mf = new Miniflare(convertV4MiniflareOptions(options)), bridge;
  const fetcher = (url, init) => mf.dispatchFetch(url, init);
  async function call(path, value, token = control, extra = {}) {
    const response = await fetcher(origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() };
  }
  const makeInput = async id => ({ id, node: 'pc2-test', operation: 'protocol-probe', challenge: randomBytes(32).toString('hex'), revision: (await call('/control/state')).body.revision });
  try {
    await mf.ready;
    await t.test('separate credentials and schema reject permissions, origins, body overflow and deployment', async () => {
      const input = await makeInput('denied');
      assert.equal((await call('/control/submit', input, node)).status, 403);
      assert.equal((await call('/node/poll', { node: 'pc2-test' }, control)).status, 403);
      assert.equal((await call('/control/submit', input, control, { origin: 'https://elsewhere.invalid' })).status, 403);
      assert.equal((await call('/control/submit', { ...input, operation: 'deploy' })).status, 409);
      assert.equal((await call('/control/submit', { ...input, revision: 42 })).status, 409);
      assert.equal((await call('/node/poll', { node: 'another-node' }, node)).status, 409);
      assert.equal((await call('/control/submit', input, control, { cookie: 'fake=1' })).status, 403);
      assert.equal((await call('/control/submit', { ...input, actor: 'human' })).status, 409);
      assert.equal((await call('/control/submit', { ...input, challenge: 'x'.repeat(3000) })).status, 409);
      assert.equal((await call('/control/state')).body.jobs.length, 0);
    });
    await t.test('lost result response is retried without repeating the local observation', async () => {
      const input = await makeInput('observed-once'); assert.equal((await call('/control/submit', input)).status, 200);
      let observations = 0, drop = true;
      bridge = openProbeBridge({ directory: join(dir, 'bridge'), origin, token: node, observe: async () => { observations++; }, fetcher: async (url, init) => {
        const response = await fetcher(url, init);
        if (url.endsWith('/node/report') && drop) { drop = false; await response.body.cancel(); throw new Error('injected lost acknowledgement'); }
        return response;
      } });
      await assert.rejects(bridge.step()); assert.equal(observations, 1); bridge.close();
      bridge = openProbeBridge({ directory: join(dir, 'bridge'), origin, token: node, fetcher, observe: async () => { observations++; } });
      assert.equal(await bridge.step(), 'observed'); assert.equal(observations, 1); bridge.close(); bridge = null;
      assert.equal((await call('/control/state')).body.jobs[0].status, 'observed');
      assert.equal((await call('/control/state')).body.deploymentVerified, false);
      assert.equal((await call('/control/submit', input)).status, 200);
      assert.equal((await call('/control/submit', { ...input, challenge: randomBytes(32).toString('hex') })).status, 409);
    });
    await t.test('SQLite state survives complete workerd restart', async () => {
      await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready;
      const state = (await call('/control/state')).body;
      assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'observed');
      assert.equal((await call('/node/poll', { node: 'pc2-test' }, node)).body.status, 'idle');
    });
    await t.test('concurrent claims deliver once and an uncertain node outcome permanently blocks new jobs', async () => {
      const input = await makeInput('claimed-once'); assert.equal((await call('/control/submit', input)).status, 200);
      const results = await Promise.all(Array.from({ length: 8 }, () => call('/node/poll', { node: 'pc2-test' }, node)));
      assert.equal(results.filter(r => r.body.status === 'delivery').length, 1);
      assert.equal(results.filter(r => r.body.status === 'claimed').length, 7);
      assert.equal((await call('/node/report', { id: input.id, challenge: '0'.repeat(64), outcome: 'observed' }, node)).status, 409);
      assert.equal((await call('/node/report', { id: input.id, challenge: input.challenge, outcome: 'unknown' }, node)).body.status, 'unknown');
      assert.equal((await call('/node/report', { id: input.id, challenge: input.challenge, outcome: 'observed' }, node)).body.status, 'unknown');
      assert.equal((await call('/control/submit', await makeInput('blocked'))).status, 409);
      await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready;
      assert.equal((await call('/node/poll', { node: 'pc2-test' }, node)).body.status, 'unknown');
    });
    await t.test('disabled or absent authentication configuration cannot serve a control channel', async () => {
      await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ENABLE_PROTOCOL_TEST: 'no' } }));
      assert.equal((await call('/control/state')).status, 503);
      await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ENABLE_PROTOCOL_TEST: 'yes', CONTROL_TOKEN: control, NODE_TOKEN: control } }));
      assert.equal((await call('/control/state')).status, 503);
    });
  } finally { bridge?.close(); await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('fixture bridge crosses real workerd/SQLite with a simulated Komodo transport, never repeated after lost acknowledgement', async () => {
  const { fixtureBackend } = await import('../helpers/node-fixture.mjs');
  const { openFixtureExecutor } = await import('../../src/fixture-node/executor.mjs');
  const { openFixtureBridge } = await import('../../src/node-bridge/bridge.mjs');
  const backend = fixtureBackend(), dir = mkdtempSync(join(tmpdir(), 'springbok-fixture-cloud-'));
  const control = randomBytes(32).toString('hex'), node = randomBytes(32).toString('hex');
  const options = { modules: true, script: bundle,
    compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0, durableObjects: { TARGET: { className: 'TargetMailbox', useSQLite: true } },
    resourcePersistencePath: join(dir, 'cloud'), telemetry: { enabled: false }, cf: false, logRequests: false,
    bindings: { ENABLE_PROTOCOL_TEST: 'yes', CONTROL_TOKEN: control, NODE_TOKEN: node, ENABLE_FIXTURE_CYCLE: 'yes', FIXTURE_BINDING: backend.c.binding } };
  let mf = new Miniflare(convertV4MiniflareOptions(options)), executor, bridge;
  async function request(path, value, token = control) {
    const r = await mf.dispatchFetch(origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: r.status, body: await r.json() };
  }
  const input = { id: 'fixed-cycle', node: 'pc2-test', operation: 'fixture-cycle', challenge: backend.c.binding, revision: 0 };
  const open = fetcher => {
    executor = openFixtureExecutor({ directory: join(dir, 'execution'), inventory: backend.inventory, transport: backend });
    bridge = openFixtureBridge({ directory: join(dir, 'bridge'), origin, token: node, executor, fetcher });
  };
  try {
    await mf.ready;
    assert.equal((await request('/control/submit', { ...input, challenge: '0'.repeat(64) })).status, 409);
    assert.equal((await request('/control/submit', input, node)).status, 403);
    assert.equal((await request('/control/submit', input)).status, 200);
    let drop = true;
    open(async (url, init) => { const r = await mf.dispatchFetch(url, init); if (url.endsWith('/node/report') && drop) { drop = false; await r.body.cancel(); throw new Error('lost ack'); } return r; });
    await assert.rejects(bridge.step()); assert.equal(backend.calls.filter(c => c.path === 'execute/Deploy').length, 4);
    bridge.close(); executor.close(); bridge = executor = null;
    await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready;
    backend.calls.length = 0; open((url, init) => mf.dispatchFetch(url, init));
    assert.equal(await bridge.step(), 'fixture-verified'); assert.equal(backend.calls.length, 0);
    const state = (await request('/control/state')).body;
    assert.equal(state.jobs[0].receipt.evidence.stages.length, 4); assert.equal(state.deploymentVerified, false);
    assert.equal((await request('/node/report', { id: input.id, challenge: input.challenge, outcome: 'observed' }, node)).status, 409);
    bridge.close(); executor.close(); bridge = executor = null;
    await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, ENABLE_FIXTURE_CYCLE: 'no' } }));
    assert.equal((await request('/control/submit', { ...input, id: 'disabled', revision: state.revision })).status, 409);
  } finally { bridge?.close(); executor?.close(); await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
