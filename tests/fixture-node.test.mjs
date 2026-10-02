import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalog, NAME, VOLUME } from '../src/fixture-node/catalog.mjs';
import { openFixtureExecutor, containerEvidence } from '../src/fixture-node/executor.mjs';
import { fixtureEvidence } from '../cloud/fixture-contract.mjs';
import { transition } from '../cloud/protocol.mjs';
import { fixtureTransport } from '../src/fixture-node/transport.mjs';
const image = n => `sha256:${String(n).repeat(64)}`, id = n => n.toString(16).padStart(24, '0');
import { fixtureBackend, normalizedConfig } from './helpers/node-fixture.mjs';

function setup(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-fixture-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backend = fixtureBackend(), options = { directory, inventory: backend.inventory, transport: backend, stageTimeoutMs: 5, pollMs: 0, ...extra };
  let executor = openFixtureExecutor(options); t.after(() => executor.close());
  return { directory, backend, get executor() { return executor; }, input: { id: 'cycle', node: 'pc2-test', operation: 'fixture-cycle', challenge: backend.c.binding, revision: 0 }, restart() { executor.close(); executor = openFixtureExecutor(options); } };
}
test('fixed fixture cycle binds all four Update/config/image/volume receipts and never reruns after restart', async t => {
  const f = setup(t), result = await f.executor.run(f.input);
  assert.equal(result.outcome, 'fixture-verified'); assert.equal(result.evidence.stages[2].health, 'expected-exit-1');
  assert.equal(f.backend.calls.filter(c => c.path === 'execute/Deploy').length, 4);
  assert.deepEqual(fixtureEvidence(result.evidence, f.input.challenge), result.evidence);
  f.restart(); f.backend.calls.length = 0; assert.deepEqual(await f.executor.run(f.input), result); assert.equal(f.backend.calls.length, 0);
  await assert.rejects(f.executor.run({ ...f.input, id: 'another' }), /already used/);
  assert.ok(Buffer.byteLength(JSON.stringify({ id: 'a'.repeat(64), challenge: f.input.challenge, ...result })) <= 2048);
});
test('write intent persists first; lost mutation response blocks restart and another request without replay', async t => {
  const f = setup(t);
  f.backend.hook = path => { if (path === 'write/UpdateDeployment') { const events = JSON.parse(readFileSync(join(f.directory, 'ledger.json'))).events; assert.equal(events.at(-1).kind, 'intent'); throw new Error('secret backend body'); } };
  assert.equal((await f.executor.run(f.input)).outcome, 'unknown'); f.restart(); f.backend.calls.length = 0;
  assert.equal((await f.executor.run(f.input)).outcome, 'unknown'); assert.equal(f.backend.calls.length, 0);
  await assert.rejects(f.executor.run({ ...f.input, id: 'other' })); assert.doesNotMatch(readFileSync(join(f.directory, 'ledger.json'), 'utf8'), /secret backend/);
});
test('unexpected failure, wrong update identity, drift and data loss prevent rollback or success', async t => {
  for (const variant of ['failed-update', 'wrong-target', 'wrong-operation', 'data-loss', 'wrong-volume', 'bad-oom']) await t.test(variant, async t => {
    const f = setup(t); let count = 0;
    f.backend.hook = (path) => {
      if (path === 'read/GetUpdate') {
        count++;
        if (variant === 'failed-update') return { _id: { $oid: id(100) }, operation: 'Deploy', target: { type: 'Deployment', id: id(1) }, status: 'Complete', success: false };
        if (variant === 'wrong-target' || variant === 'wrong-operation') return { _id: { $oid: id(100) }, operation: variant === 'wrong-operation' ? 'RunProcedure' : 'Deploy', target: { type: 'Deployment', id: id(99) }, status: 'Complete', success: true };
      }
      if (path === 'read/InspectDeploymentContainer' && ((variant === 'data-loss' && count >= 2) || variant === 'wrong-volume' || (variant === 'bad-oom' && count >= 3))) return { Id: (100 + count).toString(16).padStart(64, '0'), Image: image(count >= 3 ? 3 : count >= 2 ? 2 : 1), Mounts: [{ Type: 'volume', Name: variant === 'wrong-volume' ? 'other' : VOLUME, Destination: '/data', RW: true }], State: { Status: count >= 3 ? 'exited' : 'running', Running: count < 3, Paused: false, OOMKilled: variant === 'bad-oom', ExitCode: 1, Health: { Status: 'healthy', Log: [{ ExitCode: 0, Output: JSON.stringify({ fixture: true, version: count >= 2 ? 'v2' : 'v1', marker: 'b'.repeat(64) }) }] } } };
    };
    assert.equal((await f.executor.run(f.input)).outcome, 'unknown'); assert.ok(f.backend.calls.filter(c => c.path === 'execute/Deploy').length < 4);
  });
});
test('catalog rejects remote command/config/image substitutions; concurrent calls do not start twice', async t => {
  const f = setup(t);
  for (const inventory of [{ ...f.backend.inventory, command: 'anything' }, { ...f.backend.inventory, server: 'server-name' }, { ...f.backend.inventory, images: { v1: 'node:latest', v2: image(2), bad: image(3) } }]) assert.throws(() => catalog(inventory));
  await assert.rejects(f.executor.run({ ...f.input, challenge: '0'.repeat(64) })); assert.equal(f.backend.calls.length, 0);
  let release, paused = false; f.backend.hook = path => path === 'write/UpdateDeployment' && !paused ? new Promise(resolve => { paused = true; release = resolve; }) : undefined;
  const running = f.executor.run(f.input); while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.executor.run(f.input), /busy/); assert.throws(() => f.executor.close(), /busy/); release({}); await running;
});
test('cloud receipt validation rejects forged ordering, persistence and rollback and preserves unknown on a late result', async t => {
  const f = setup(t), result = await f.executor.run(f.input);
  for (const mutate of [v => v.stages.reverse(), v => { v.stages[3].marker = 'b'.repeat(64); }, v => { v.stages[3].image = image(2); }, v => { v.stages[1].updateId = v.stages[0].updateId; }, v => { delete v.stages[0].containerId; }, v => { v.stages[3].containerId = v.stages[0].containerId; }]) { const value = structuredClone(result.evidence); mutate(value); assert.throws(() => fixtureEvidence(value, f.input.challenge)); }
  let state = transition({ revision: 0, jobs: [] }, 'submit', f.input, 0).state; state = transition(state, 'poll', { node: 'pc2-test' }, 1).state;
  const receipt = { id: f.input.id, challenge: f.input.challenge, ...result };
  const first = transition(state, 'report', receipt, 600000); assert.equal(first.response.status, 'unknown'); assert.equal(transition(first.state, 'report', receipt, 600001).response.status, 'unknown');
  const timely = transition(state, 'report', receipt, 2); assert.equal(timely.response.status, 'fixture-verified'); assert.deepEqual(transition(timely.state, 'report', receipt, 3).state, timely.state);
});
test('Core transport stays fixed, rejects redirects/extra operations and redacts errors', async () => {
  const calls = []; const transport = await fixtureTransport('a'.repeat(64), { fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ type: 'Jwt', data: { jwt: 'synthetic' } }); } });
  assert.throws(() => transport.call('write/DeleteDeployment', {})); await transport.call('read/GetVersion', {});
  assert.ok(calls.every(c => c.url.startsWith('http://core:9120/') && c.options.redirect === 'error'));
  await assert.rejects(fixtureTransport('a'.repeat(64), { fetcher: async () => new Response('secret', { status: 500 }) }), error => !error.message.includes('secret'));
});

test('local preparation creates only one fixed resource, validates images first and never retries uncertain creation', async () => {
  const { prepareInventory, configuration } = await import('../src/fixture-node/catalog.mjs');
  const images = { v1: image(1), v2: image(2), bad: image(3) }, calls = [];
  const transport = { async call(path, params) { calls.push({ path, params }); if (path === 'read/GetServer') return { _id: { $oid: id(2) }, name: 'springbok-node-test' }; if (path === 'read/GetServerState') return { status: 'Ok' }; throw new Error('lost create response'); } };
  await assert.rejects(prepareInventory({ ...images, v1: 'node:latest' }, transport)); assert.equal(calls.length, 0);
  await assert.rejects(prepareInventory(images, transport)); assert.equal(calls.filter(c => c.path === 'write/CreateDeployment').length, 1);
  assert.deepEqual(calls.at(-1).params, { name: NAME, config: configuration(id(2), image(1)) });
});

test('configuration drift and uncertain journal writes stop before Deploy', async t => {
  await t.test('changed backend configuration', async t => {
    const f = setup(t); let reads = 0;
    f.backend.hook = path => { if (path === 'read/GetDeployment' && ++reads === 3) return { _id: { $oid: id(1) }, name: NAME, config: { ...f.backend.c.configs.v1, ports: '8080:8080' } }; };
    assert.equal((await f.executor.run(f.input)).outcome, 'unknown'); assert.equal(f.backend.calls.filter(c => c.path === 'execute/Deploy').length, 0);
  });
  await t.test('intent cannot be persisted', async t => {
    const { atomicWrite } = await import('../src/execution/journal.mjs');
    const f = setup(t, { storage: { writeFile(directory, file, bytes) { if (JSON.parse(bytes).events.at(-1)?.kind === 'intent') throw new Error('write unavailable'); atomicWrite(directory, file, bytes); } } });
    assert.equal((await f.executor.run(f.input)).outcome, 'unknown'); assert.equal(f.backend.calls.filter(c => c.path.startsWith('write/') || c.path.startsWith('execute/')).length, 0);
  });
});
test('assembly and ordinary CI keep privileged management private and exclude a daemon mount from fixture smoke', () => {
  const compose = readFileSync(new URL('../deploy/node-fixture/compose.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /^\s+(?:ports|privileged|network_mode):/m);
  assert.match(compose, /source: \/run\/user\/\$\{SPRINGBOK_ROOTLESS_UID/);
  const bridge = compose.split('  bridge:')[1].split('\nnetworks:')[0]; assert.doesNotMatch(bridge, /docker\.sock|keys:\/config/);
  assert.match(compose, /mongo-data:\/data\/db/); assert.match(compose, /control: \{internal: true\}/);
  const smoke = readFileSync(new URL('../scripts/ci/node-fixture-smoke.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(smoke, /docker\.sock|--privileged|docker (?:system|container|volume) prune/);
  const workflow = readFileSync(new URL('../.github/workflows/cloud-protocol.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /pull_request_target|wrangler deploy|komodo\.sh|secrets\./);
});

test('pinned Komodo newline normalization survives preparation and exact resource matching without trimming the digest', async () => {
  const { prepareInventory, configuration } = await import('../src/fixture-node/catalog.mjs');
  const { matchesResource } = await import('../src/execution/plan.mjs');
  const images = { v1: image(1), v2: image(2), bad: image(3) };
  const config = configuration(id(2), images.v1);
  assert.equal(config.volumes, 'springbok-fixture-data:/data\n'); assert.equal(config.labels, 'springbok.fixture-node=true\n');
  assert.deepEqual(normalizedConfig(config), config);
  const transport = { async call(path, params) {
    if (path === 'read/GetServer') return { _id: { $oid: id(2) }, name: 'springbok-node-test' };
    if (path === 'read/GetServerState') return { status: 'Ok' };
    if (path === 'write/CreateDeployment') return { _id: { $oid: id(1) }, name: params.name, config: normalizedConfig(params.config) };
    throw new Error('unexpected request');
  } };
  const inventory = await prepareInventory(images, transport), c = catalog(inventory);
  const resource = { _id: { $oid: id(1) }, name: NAME, config: normalizedConfig(config) };
  assert.equal(matchesResource(resource, c.plans.v1), true);
  resource.config.volumes = resource.config.volumes.trimEnd(); assert.equal(matchesResource(resource, c.plans.v1), false);
});
test('container ID must be real, present and unique across replacement stages', async t => {
  for (const repeated of [false, true]) await t.test(repeated ? 'reused ID' : 'missing ID', async t => {
    const f = setup(t), original = f.backend.call.bind(f.backend);
    const wrapper = { ...f.backend, async call(path, params) {
      const value = await original(path, params);
      if (path === 'read/InspectDeploymentContainer') { if (repeated) value.Id = 'f'.repeat(64); else delete value.Id; }
      return value;
    } };
    f.executor.close(); const executor = openFixtureExecutor({ directory: f.directory, inventory: f.backend.inventory, transport: wrapper, stageTimeoutMs: 5, pollMs: 0 });
    try { assert.equal((await executor.run(f.input)).outcome, 'unknown'); assert.ok(f.backend.calls.filter(c => c.path === 'execute/Deploy').length < 4); } finally { executor.close(); }
  });
});
