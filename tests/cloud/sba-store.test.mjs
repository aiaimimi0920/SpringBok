import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { sbaRequest, sbaDigest } from '../../cloud/sba-control.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const script = (await build({ stdin: { contents: `
import { SbaDeployment } from './cloud/sba-store.mjs';
import { readSbaReceipt } from './src/sba/receipt.mjs';
export { SbaDeployment };
export default { async fetch(request, env) {
  try {
    const { method, args } = await request.json();
    if (method === 'receipt') return Response.json(await readSbaReceipt(new Uint8Array(args[0]), args[1]));
    const policy = JSON.parse(env.SBA_POLICY);
    const stub = env.SBA_TASKS.get(env.SBA_TASKS.idFromName('sba/v1/' + policy.github.applicationRepository + '/' + policy.environment));
    return Response.json(await stub[method](...args));
  } catch { return new Response('rejected', { status: 409 }); }
}};`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })).outputFiles[0].text;
const policy = { github: { repository: 'owner/executor', repositoryId: 123, applicationRepository: 'owner/application',
  workflowId: 99, workflowPath: '.github/workflows/sba-execute.yml', executorSha: 'a'.repeat(40), ref: `sba-executor-${'a'.repeat(40)}` },
  sourceSha: 'b'.repeat(40), environment: 'staging', configuration: {}, secretNames: [], runnerOrigin: 'https://runner.example.invalid' };
const manifest = { schemaVersion: 2, id: 'sample-app', name: 'Sample', version: '1.0.0', entrypoint: 'entry.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 60 } }, secrets: [] };
const actor = 'c'.repeat(64), request = sbaRequest(policy, 'test-task', manifest), requestDigest = await sbaDigest(request);
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-sba-store-'));
  const options = { name: 'sba-store-test', script, modules: true, compatibilityDate: '2026-07-30',
    host: '127.0.0.1', port: 0, durableObjects: { SBA_TASKS: { className: 'SbaDeployment', useSQLite: true } },
    resourcePersistencePath: join(directory, 'state'), telemetry: { enabled: false }, cf: false,
    bindings: { ENABLE_SBA: 'yes', SBA_GITHUB_TOKEN: 'synthetic', SBA_POLICY: JSON.stringify(policy), ADMIN_ORIGIN: 'https://admin.example.invalid' } };
  let mf;
  const restart = async () => { await mf?.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready; };
  t.after(async () => { await mf?.dispose(); rmSync(directory, { recursive: true, force: true }); });
  await restart();
  return { restart, call: async (method, ...args) => {
    const response = await mf.dispatchFetch('https://test.invalid/', { method: 'POST', body: JSON.stringify({ method, args }) });
    return { status: response.status, value: response.ok ? await response.json() : await response.text() };
  } };
}
test('write-before-dispatch and one-time permit survive concurrency and restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('begin', null, { request, manifest })).status, 409);
  const begins = await Promise.all(Array.from({ length: 4 }, () => f.call('begin', actor, { request, manifest })));
  assert.ok(begins.every(r => r.status === 200));
  assert.equal(begins.filter(r => r.value.dispatch).length, 1);
  await f.restart();
  assert.equal((await f.call('begin', actor, { request, manifest })).value.dispatch, false);
  assert.equal((await f.call('begin', actor, { request: { ...request, taskId: 'different-task' }, manifest })).status, 409);
  assert.equal((await f.call('snapshot', 'd'.repeat(64))).status, 409);
  const permits = await Promise.all(Array.from({ length: 4 }, () => f.call('permit', request.taskId, requestDigest, 456)));
  assert.equal(permits.filter(r => r.status === 200).length, 1);
  const permit = permits.find(r => r.status === 200).value;
  await f.restart();
  assert.equal((await f.call('permit', request.taskId, requestDigest, 456)).status, 409);
  const result = { schemaVersion: 2, taskId: request.taskId, action: 'deploy', sourceSha: request.sourceSha,
    applicationVersion: '1.0.0', status: 'succeeded', checks: [{ id: 'health-check', passed: true }] };
  const envelope = { schemaVersion: 1, runId: 456, runAttempt: 1, executorSha: policy.github.executorSha,
    requestDigest, permitId: permit.permitId, result };
  assert.equal((await f.call('settle', actor, { ...envelope, schemaVersion: 2 })).status, 409);
  assert.equal((await f.call('settle', actor, { ...envelope, injected: true })).status, 409);
  assert.equal((await f.call('settle', actor, { ...envelope, runId: 457 })).status, 409);
  assert.equal((await f.call('settle', actor, envelope)).value.job.status, 'succeeded');
  await f.restart();
  assert.equal((await f.call('settle', actor, envelope)).value.job.status, 'succeeded');
  assert.equal((await f.call('settle', actor, { ...envelope, result: { ...result, status: 'failed' } })).status, 409);
});
test('dispatch uncertainty is not redispatched; exact run can consume only once', async t => {
  const f = await fixture(t);
  await f.call('begin', actor, { request, manifest });
  await f.call('attachRun', actor, request.taskId, { status: 'unknown', requestDigest });
  assert.equal((await f.call('begin', actor, { request, manifest })).value.dispatch, false);
  assert.equal((await f.call('permit', request.taskId, requestDigest, 456)).status, 200);
  await f.call('attachRun', actor, request.taskId, { status: 'dispatched', requestDigest, runId: 456 });
  assert.equal((await f.call('snapshot', actor)).value.job.status, 'running');
  await f.call('markUnknown', actor, request.taskId);
  await f.restart();
  assert.equal((await f.call('permit', request.taskId, requestDigest, 456)).status, 409);
  assert.equal((await f.call('begin', actor, { request, manifest })).value.dispatch, false);
});

test('actual workerd verifies deflated receipt bytes before result acceptance', async t => {
  const { zip } = await import('../sba-zip-fixture.mjs');
  const { createHash } = await import('node:crypto');
  const f = await fixture(t);
  const envelope = { schemaVersion: 1, runId: 456, runAttempt: 1, executorSha: policy.github.executorSha,
    requestDigest, permitId: 'e'.repeat(64), result: { schemaVersion: 2, taskId: request.taskId, action: 'deploy',
      sourceSha: request.sourceSha, applicationVersion: '1.0.0', status: 'succeeded', checks: [{ id: 'health-check', passed: true }] } };
  for (const descriptor of [false, true]) {
    const archive = zip(envelope, { method: 8, descriptor });
    const expected = { ...envelope, request, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
    const response = await f.call('receipt', [...archive], expected);
    assert.equal(response.status, 200); assert.deepEqual(response.value, envelope);
    archive[40] ^= 1;
    assert.equal((await f.call('receipt', [...archive], expected)).status, 409);
  }
});
