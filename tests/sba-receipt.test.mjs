import test from 'node:test';
import assert from 'node:assert/strict';
import { zip as makeZip } from './sba-zip-fixture.mjs';
const zip = (value = envelope, options) => makeZip(value, options);
import { createHash } from 'node:crypto';
import { readSbaReceipt } from '../src/sba/receipt.mjs';
const request = { schemaVersion: 2, taskId: 'sample-task', action: 'deploy', sourceSha: 'a'.repeat(40), applicationVersion: '1.0.0' };
const envelope = { schemaVersion: 1, runId: 456, runAttempt: 1, executorSha: 'b'.repeat(40), requestDigest: 'c'.repeat(64),
  permitId: 'd'.repeat(64), result: { ...request, status: 'succeeded', checks: [{ id: 'health-check', passed: true }] } };
const expected = { ...envelope, request };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
for (const options of [{ method: 0 }, { method: 8 }, { method: 8, descriptor: true }]) {
  test(`accept bounded single receipt ${JSON.stringify(options)}`, async () => {
    const archive = zip(envelope, options);
    assert.deepEqual(await readSbaReceipt(archive, { ...expected, digest: digest(archive) }), envelope);
  });
}
const rejects = async (archive, override = {}) => assert.rejects(readSbaReceipt(archive, { ...expected, digest: digest(archive), ...override }), /SBA_RECEIPT_REJECTED/);
test('reject untrusted digest and envelope identity', async () => {
  const archive = zip();
  await rejects(archive, { digest: `sha256:${'0'.repeat(64)}` });
  for (const [key, value] of Object.entries({ schemaVersion: 2, runAttempt: 2, runId: 457, executorSha: 'e'.repeat(40),
    requestDigest: 'e'.repeat(64), permitId: 'e'.repeat(64), extra: true })) await rejects(zip({ ...envelope, [key]: value }));
  await rejects(zip({ ...envelope, result: { ...envelope.result, checks: [] } }));
});
test('reject path traversal, multiple entries, encryption, corrupt headers and CRC', async () => {
  for (const name of ['../receipt.json', '/receipt.json', 'other.json', 'dir/receipt.json']) await rejects(zip(envelope, { name }));
  for (const mutate of [b => b.writeUInt16LE(2, b.length - 12), b => b.writeUInt16LE(1, 6),
    b => b.writeUInt32LE(1, 14), b => b.writeUInt16LE(1, 28), b => b.writeUInt16LE(99, 8),
    b => b.writeUInt32LE(0xffffffff, b.length - 6)]) { const b = zip(); mutate(b); await rejects(b); }
  await rejects(Buffer.concat([zip(), Buffer.from('extra')]));
  await rejects(zip(envelope, { raw: 'x'.repeat(32769) }));
  await rejects(zip(envelope, { raw: '{invalid' }));
  await rejects(Buffer.alloc(65537));
});
test('reject compressed expansion beyond declared bounds', async () => {
  const archive = zip(envelope, { raw: 'x'.repeat(32768) });
  const central = archive.readUInt32LE(archive.length - 6);
  archive.writeUInt32LE(1, 22); archive.writeUInt32LE(1, central + 24);
  await rejects(archive);
});

// 使用同一真实 ZIP fixture 验证完整 run → artifact → 签名下载 → 回执链。
const { recoverSbaReceipt } = await import('../src/sba/artifact.mjs');
const { createGithubExecutor } = await import('../src/sba/github.mjs');
const config = { repository: 'owner/executor', repositoryId: 123, applicationRepository: 'owner/application',
  workflowId: 99, workflowPath: '.github/workflows/sba-execute.yml', ref: `sba-executor-${envelope.executorSha}`, executorSha: envelope.executorSha };
const manifest = { schemaVersion: 2, id: 'sample-app', name: 'Sample', version: '1.0.0', entrypoint: 'entry.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 60 } }, secrets: [] };
const fullRequest = { ...request, repository: config.applicationRepository, applicationId: 'sample-app', environment: 'staging', configuration: {}, previous: null };
const binding = await createGithubExecutor(config, { token: 'synthetic' }).prepare(fullRequest, manifest);
function transport({ location = 'https://synthetic.blob.core.windows.net/receipt?sig=synthetic', transform, runStatus = 'completed' } = {}) {
  const result = { ...envelope, requestDigest: binding.requestDigest }, archive = zip(result), calls = [];
  const responses = [Response.json({ id: 456, workflow_id: 99, event: 'workflow_dispatch', head_sha: config.executorSha,
    head_branch: config.ref, path: config.workflowPath, run_attempt: 1, repository: { id: 123, full_name: config.repository },
    head_repository: { id: 123, full_name: config.repository }, display_title: binding.title, pull_requests: [], status: runStatus,
    conclusion: runStatus === 'completed' ? 'success' : null }),
  Response.json({ total_count: 1, artifacts: [{ id: 789, name: binding.artifactName, expired: false, size_in_bytes: archive.length,
    digest: digest(archive), workflow_run: { id: 456, repository_id: 123, head_repository_id: 123, head_sha: config.executorSha, head_branch: config.ref } }] }),
  new Response(null, { status: 302, headers: { location } }), new Response(transform ? transform(archive) : archive)];
  return { result, calls, run: () => recoverSbaReceipt(config, { ...envelope, request: fullRequest, manifest, requestDigest: binding.requestDigest },
    { token: 'synthetic-private', fetchImpl: async (url, options) => { calls.push({ url, options }); assert.ok(responses.length); return responses.shift(); } }) };
}
test('trusted artifact recovery verifies receipt and never forwards API credentials', async () => {
  const t = transport();
  assert.deepEqual(await t.run(), { status: 'verified-receipt', envelope: t.result });
  assert.equal(t.calls.length, 4);
  assert.equal(t.calls[2].options.headers.authorization, 'Bearer synthetic-private');
  assert.equal(t.calls[2].options.redirect, 'manual');
  assert.equal(t.calls[3].options.headers, undefined);
  assert.equal(t.calls[3].options.redirect, 'manual');
});
test('artifact redirects fail closed and changed bytes cannot become a receipt', async () => {
  for (const location of ['http://synthetic.blob.core.windows.net/a', 'https://evil.invalid/a',
    'https://synthetic.blob.core.windows.net.evil.invalid/a', 'https://user:password@synthetic.blob.core.windows.net/a']) {
    const t = transport({ location }); await assert.rejects(t.run(), /SBA_ARTIFACT_REJECTED/); assert.equal(t.calls.length, 3);
  }
  for (const transform of [b => { b[40] ^= 1; return b; }, () => Buffer.alloc(65537)]) {
    await assert.rejects(transport({ transform }).run(), /SBA_ARTIFACT_REJECTED/);
  }
});
test('pending run does not request an artifact or claim success', async () => {
  const t = transport({ runStatus: 'in_progress' });
  assert.equal((await t.run()).status, 'pending'); assert.equal(t.calls.length, 1);
});
