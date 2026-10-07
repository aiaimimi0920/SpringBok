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
import { SbaDeployment as Store } from './cloud/sba-store.mjs';
import { readSbaReceipt } from './src/sba/receipt.mjs';
export class SbaDeployment extends Store {
  seedLegacy(state, digest) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('CREATE TABLE sba_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, policy_digest TEXT NOT NULL)');
      this.ctx.storage.sql.exec('CREATE TABLE sba_deployment (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
      this.ctx.storage.sql.exec('INSERT INTO sba_meta VALUES(1,1,?)', digest);
      this.ctx.storage.sql.exec('INSERT INTO sba_deployment VALUES(1,?)', JSON.stringify(state));
    });
    return true;
  }
  tamperHistory() { this.ctx.storage.sql.exec('UPDATE sba_unstarted_history SET digest=?', 'corrupt'); return true; }
  loseFirstHistory() { this.ctx.storage.sql.exec('DELETE FROM sba_unstarted_history WHERE sequence=1'); return true; }
}
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
    bindings: { ENABLE_SBA: 'yes', SBA_GITHUB_TOKEN: 'synthetic', SBA_RECOVERY_EXECUTOR_SHA: 'f'.repeat(40), SBA_POLICY: JSON.stringify(policy), ADMIN_ORIGIN: 'https://admin.example.invalid' } };
  let mf;
  const restart = async () => { await mf?.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready; };
  t.after(async () => { await mf?.dispose(); rmSync(directory, { recursive: true, force: true }); });
  await restart();
  return { restart, policy: async (value, approved = 'f'.repeat(40)) => { options.bindings.SBA_POLICY = JSON.stringify(value); options.bindings.SBA_RECOVERY_EXECUTOR_SHA = approved; await restart(); }, call: async (method, ...args) => {
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

const successor = () => ({ ...policy, github: { ...policy.github, executorSha: 'f'.repeat(40), ref: `sba-executor-${'f'.repeat(40)}` } });
const recoveryProof = () => ({ runId: 456, requestDigest, executorSha: policy.github.executorSha, conclusion: 'failure', verifiedAt: Date.now() });
test('unstarted recovery preserves history across policy cutover and restart without reusing task or dispatch', async t => {
  const f = await fixture(t);
  await f.call('begin', actor, { request, manifest });
  await f.call('attachRun', actor, request.taskId, { status: 'dispatched', requestDigest, runId: 456 });
  await f.call('markUnknown', actor, request.taskId); // 包括许可截止后 unknown 的未消费状态。
  await f.restart();
  const response = await f.call('recoverUnstarted', actor, request.taskId, successor(), recoveryProof());
  assert.equal(response.status, 200); assert.equal(response.value.outcome, 'not-executed');
  assert.equal((await f.call('snapshot', actor)).status, 409); // 旧 env 不得继续发放授权。
  await f.policy(successor());
  const snapshot = (await f.call('snapshot', actor)).value;
  assert.equal(snapshot.ready, true); assert.equal(snapshot.job, null);
  assert.equal(snapshot.history.length, 1); assert.deepEqual(snapshot.history[0].job.request, request);
  assert.equal(snapshot.history[0].job.status, 'unknown'); assert.equal(snapshot.history[0].job.permitAt, null);
  assert.equal(snapshot.history[0].executorSha, policy.github.executorSha);
  assert.equal((await f.call('snapshot', 'd'.repeat(64))).status, 409);
  assert.equal((await f.call('permit', request.taskId, requestDigest, 456)).status, 409);
  assert.equal((await f.call('begin', actor, { request, manifest })).status, 409);
  const fresh = { ...request, taskId: 'new-approved-task' };
  assert.equal((await f.call('begin', actor, { request: fresh, manifest })).value.dispatch, true);
  await f.restart();
  assert.equal((await f.call('begin', actor, { request: fresh, manifest })).value.dispatch, false);
  assert.equal((await f.call('snapshot', actor)).value.history[0].taskId, request.taskId);
});
test('recovery refuses missing run, consumed permit, stale evidence, unrelated policy and unproved drift', async t => {
  const f = await fixture(t);
  await f.call('begin', actor, { request, manifest });
  assert.equal((await f.call('recoverUnstarted', actor, request.taskId, successor(), recoveryProof())).status, 409);
  await f.call('attachRun', actor, request.taskId, { status: 'dispatched', requestDigest, runId: 456 });
  for (const proof of [{ ...recoveryProof(), runId: 457 }, { ...recoveryProof(), verifiedAt: Date.now() - 60001 },
    { ...recoveryProof(), verifiedAt: Date.now() + 60000 }, { ...recoveryProof(), conclusion: 'success' },
    { ...recoveryProof(), requestDigest: 'e'.repeat(64) }, { ...recoveryProof(), executorSha: 'e'.repeat(40) }])
    assert.equal((await f.call('recoverUnstarted', actor, request.taskId, successor(), proof)).status, 409);
  assert.equal((await f.call('recoverUnstarted', actor, request.taskId, { ...successor(), configuration: { other: true } }, recoveryProof())).status, 409);
  assert.equal((await f.call('recoverUnstarted', actor, request.taskId, policy, recoveryProof())).status, 409);
  await f.policy(successor()); assert.equal((await f.call('snapshot', actor)).status, 409);
  await f.policy(policy); assert.equal((await f.call('permit', request.taskId, requestDigest, 456)).status, 200);
  await f.call('markUnknown', actor, request.taskId);
  assert.equal((await f.call('recoverUnstarted', actor, request.taskId, successor(), recoveryProof())).status, 409);
  await f.restart(); assert.equal((await f.call('snapshot', actor)).value.job.status, 'unknown');
});
test('permit and recovery race grants at most one authority', async t => {
  const f = await fixture(t); await f.call('begin', actor, { request, manifest });
  await f.call('attachRun', actor, request.taskId, { status: 'dispatched', requestDigest, runId: 456 });
  const outcomes = await Promise.all([f.call('recoverUnstarted', actor, request.taskId, successor(), recoveryProof()), f.call('permit', request.taskId, requestDigest, 456)]);
  assert.equal(outcomes.filter(x => x.status === 200).length, 1);
});
test('real legacy v1 state survives deadline, additive archive, approved cutover and corruption rejection', async t => {
  const f = await fixture(t), now = Date.now() - 1000000;
  const legacy = { actor, request, manifest, requestDigest, status: 'dispatched', runId: 456, submittedAt: now,
    permitDeadline: now + 900000, permitAt: null, permitId: null, resultDeadline: null, result: null, errorCode: null };
  assert.equal((await f.call('seedLegacy', legacy, await sbaDigest(policy))).status, 200);
  assert.equal((await f.call('snapshot', actor)).value.job.status, 'unknown');
  assert.equal((await f.call('recoverUnstarted', actor, request.taskId, successor(), recoveryProof())).status, 200);
  await f.policy(successor()); assert.equal((await f.call('snapshot', actor)).value.history[0].job.submittedAt, now);
  await f.call('tamperHistory'); await f.restart();
  assert.equal((await f.call('snapshot', actor)).status, 409);
  assert.equal((await f.call('begin', actor, { request: { ...request, taskId: 'fresh-task' }, manifest })).status, 409);
});
test('losing an older history row after two cutovers fails closed and cannot reuse its task ID', async t => {
  const f = await fixture(t); await f.call('begin', actor, { request, manifest });
  await f.call('attachRun', actor, request.taskId, { status: 'dispatched', requestDigest, runId: 456 });
  assert.equal((await f.call('recoverUnstarted', actor, request.taskId, successor(), recoveryProof())).status, 200);
  await f.policy(successor(), 'e'.repeat(40));
  const second = { ...request, taskId: 'second-task' }, secondDigest = await sbaDigest(second);
  await f.call('begin', actor, { request: second, manifest });
  await f.call('attachRun', actor, second.taskId, { status: 'dispatched', requestDigest: secondDigest, runId: 457 });
  const third = { ...successor(), github: { ...policy.github, executorSha: 'e'.repeat(40), ref: `sba-executor-${'e'.repeat(40)}` } };
  const proof = { runId: 457, requestDigest: secondDigest, executorSha: successor().github.executorSha, conclusion: 'failure', verifiedAt: Date.now() };
  assert.equal((await f.call('recoverUnstarted', actor, second.taskId, third, proof)).status, 200);
  await f.policy(third); assert.equal((await f.call('snapshot', actor)).value.history.length, 2);
  await f.call('loseFirstHistory'); await f.restart();
  assert.equal((await f.call('snapshot', actor)).status, 409);
  assert.equal((await f.call('begin', actor, { request, manifest })).status, 409);
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
