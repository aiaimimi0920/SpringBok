import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deploymentRequest, releaseManifest, testProcedureRequest, KOMODO_VERSION } from '../src/komodo/mapping.mjs';
import { ciClient, completedUpdate } from '../src/komodo/ci-client.mjs';
import { validateManifest, SERVICES } from '../src/contract.mjs';
const v1 = `sha256:${'1'.repeat(64)}`;
const v2 = `sha256:${'2'.repeat(64)}`;
const id = 'a'.repeat(24);
test('Komodo 2.3.3 mapping yields eight fixed isolated targets and immutable config bindings', () => {
  assert.equal(KOMODO_VERSION, '2.3.3');
  const a = validateManifest(releaseManifest(v1)), b = validateManifest(releaseManifest(v2));
  for (const service of SERVICES) {
    assert.notEqual(a.services.find(s => s.id === service).configDigest, b.services.find(s => s.id === service).configDigest);
    for (const env of ['test', 'production']) {
      const req = deploymentRequest(service, env, v1);
      assert.equal(req.name, `springbok-${service}-${env}`);
      assert.deepEqual(req.config.image, { type: 'Image', params: { image: v1 } });
      assert.equal(req.config.network, 'none'); assert.equal(req.config.restart, 'no');
      assert.equal(req.config.volumes, ''); assert.equal(req.config.ports, ''); assert.equal(req.config.command, '');
      for (const key of ['auto_update', 'poll_for_updates', 'redeploy_on_build']) assert.equal(req.config[key], false);
    }
  }
  assert.throws(() => deploymentRequest('gateway;sh', 'test', v1));
  assert.throws(() => deploymentRequest('gateway', 'production', 'node:latest'));
  assert.throws(() => deploymentRequest('gateway', 'test', v1, 'real-server'));
});
test('Procedures map only one exact test deployment; no automatic schedule, webhook or production', () => {
  for (const service of SERVICES) {
    const req = testProcedureRequest(service);
    assert.equal(req.config.schedule_enabled, false); assert.equal(req.config.webhook_enabled, false);
    assert.deepEqual(req.config.stages[0].executions, [{ enabled: true, execution: {
      type: 'Deploy', params: { deployment: `springbok-${service}-test` },
    } }]);
    assert.doesNotMatch(JSON.stringify(req), /production|Batch|terminal|command/);
  }
});
test('client confines endpoints, blocks redirects, and redacts server responses', async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('LoginLocalUser')) return { ok: true, json: async () => ({ type: 'Jwt', data: { jwt: 'synthetic-test-token' } }) };
      return { ok: false, status: 403, json: async () => ({ secret: 'never-print-this' }) };
    };
    const c = ciClient();
    await assert.rejects(c.call('write/CreateDeployment', {}), /not permitted/);
    await c.login('x'.repeat(64));
    await assert.rejects(c.call('terminal/execute', {}), /not permitted/);
    await assert.rejects(c.call('read/GetVersion'), /^Error: Komodo read\/GetVersion HTTP 403$/);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.url.startsWith('http://core:9120/') && r.options.redirect === 'error'));
  } finally { globalThis.fetch = original; }
});
test('execution results require exact update, operation, target, final status and success', async () => {
  const complete = { _id: { $oid: id }, operation: 'Deploy', target: { type: 'Deployment', id: 'target' }, status: 'Complete', success: true };
  const client = value => ({ call: async () => value });
  assert.equal(await completedUpdate(client(complete), { _id: { $oid: id } }, 'Deploy', 'target'), id);
  for (const change of [{ success: false }, { operation: 'Other' }, { target: { type: 'Deployment', id: 'wrong' } },
    { target: { type: 'Procedure', id: 'target' } }, { _id: { $oid: 'b'.repeat(24) } }]) {
    await assert.rejects(completedUpdate(client({ ...complete, ...change }), { _id: { $oid: id } }, 'Deploy', 'target'), /failed or mismatched/);
  }
  await assert.rejects(completedUpdate(client(complete), {}, 'Deploy', 'target'), /missing execution ID/);
});
test('integration refuses ordinary local hosts before Docker or credentials', () => {
  const result = spawnSync('bash', ['scripts/integration/komodo.sh'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stdout, /explicitly approved disposable/);
});
test('privileged integration remains bounded with no public ports, secrets logs, root/proc mounts or artifacts', () => {
  const sh = readFileSync(new URL('../scripts/integration/komodo.sh', import.meta.url), 'utf8');
  assert.match(sh, /docker network create --internal/); assert.match(sh, /trap cleanup EXIT/);
  assert.match(sh, /--log-driver=none/); assert.match(sh, /mktemp -d \/dev\/shm/);
  assert.doesNotMatch(sh, /--privileged|--network[= ]host|--publish|docker logs|source=\/proc|source=\/,|set -x/);
  const wf = readFileSync(new URL('../.github/workflows/komodo-integration.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /pull_request|secrets\.|upload-artifact|contents: write/);
  assert.match(wf, /github\.repository == 'aiaimimi0920\/SpringBok'/);
});
