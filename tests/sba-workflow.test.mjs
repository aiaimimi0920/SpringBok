import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sbaDigest, canonicalSba } from '../cloud/sba-control.mjs';
import { workflowInput, runSbaWorkflow } from '../scripts/sba-workflow.mjs';
const sha = 'a'.repeat(40), request = { schemaVersion: 2, taskId: 'sba-test-task', action: 'deploy', repository: 'owner/application',
  sourceSha: 'b'.repeat(40), applicationId: 'sample-app', applicationVersion: '1.0.0', environment: 'staging', configuration: {}, previous: null };
const manifest = { schemaVersion: 2, id: 'sample-app', name: 'Sample', version: '1.0.0', entrypoint: 'entry.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 60 } }, secrets: ['CLOUDFLARE_API_TOKEN'] };
const requestJson = canonicalSba(request), requestDigest = await sbaDigest(requestJson);
const base = { SBA_EXECUTOR_SHA: sha, GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha, GITHUB_REF: `refs/tags/sba-executor-${sha}`,
  GITHUB_REF_TYPE: 'tag', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_RUN_ID: '456', GITHUB_REPOSITORY: 'owner/executor', GITHUB_WORKFLOW_REF: `owner/executor/.github/workflows/sba-execute.yml@refs/tags/sba-executor-${sha}`,
  SBA_REQUEST_JSON: requestJson, SBA_REQUEST_SHA256: requestDigest, SBA_RUNNER_ORIGIN: 'https://runner.example.invalid',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc?api-version=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-control-token' };
const permit = { permitId: 'c'.repeat(64), requestDigest, request, manifest, secrets: { CLOUDFLARE_API_TOKEN: 'synthetic-deployment-token' } };
test('workflow input binds fixed executor tag, task digest and first hosted attempt', async () => {
  assert.equal((await workflowInput(base)).runId, 456);
  for (const changed of [{ GITHUB_SHA: 'd'.repeat(40) }, { GITHUB_WORKFLOW_SHA: 'd'.repeat(40) }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'pull_request' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { SBA_REQUEST_SHA256: 'd'.repeat(64) }, { SBA_RUNNER_ORIGIN: 'http://runner.example.invalid' }])
    await assert.rejects(workflowInput({ ...base, ...changed }), /SBA_WORKFLOW_REJECTED/);
});
async function scenario(t, { response = permit, failPermit = false, businessStatus = 'succeeded' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'springbok-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; let executions = 0;
  const result = { schemaVersion: 2, taskId: request.taskId, action: 'deploy', sourceSha: request.sourceSha, applicationVersion: '1.0.0',
    status: businessStatus, checks: businessStatus === 'succeeded' ? [{ id: 'health-check', passed: true }] : [] };
  const run = () => runSbaWorkflow({ environment: base, tempRoot: root,
    checkout: async () => ({ root: join(root, 'application'), input: request, manifest }),
    execute: async input => { executions++; assert.equal(calls.length, 2); assert.equal(input.environment.CLOUDFLARE_API_TOKEN, 'synthetic-deployment-token'); return { result }; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options }); assert.equal(options.redirect, 'manual');
      if (calls.length === 1) { assert.equal(new URL(url).searchParams.get('audience'), `${base.SBA_RUNNER_ORIGIN}/sba/v2/permit`);
        assert.equal(options.headers.authorization, 'Bearer synthetic-control-token'); return Response.json({ value: 'synthetic-oidc' }); }
      assert.equal(calls.length, 2); assert.equal(options.headers.authorization, 'Bearer synthetic-oidc');
      assert.deepEqual(JSON.parse(options.body), { taskId: request.taskId, requestDigest });
      if (failPermit) throw new Error('synthetic-lost-response');
      return Response.json(response);
    } });
  return { root, calls, run, executions: () => executions };
}
test('valid permit executes once and writes only bound receipt, not credentials', async t => {
  const s = await scenario(t); const result = await s.run();
  assert.equal(s.executions(), 1); assert.equal(result.result.status, 'succeeded');
  const text = await readFile(join(s.root, 'sba-receipt/receipt.json'), 'utf8');
  assert.doesNotMatch(text, /synthetic-(control|deployment)-token|synthetic-oidc|secrets/);
  assert.equal(JSON.parse(text).permitId, permit.permitId);
});
test('lost permit response never retries or executes', async t => {
  const s = await scenario(t, { failPermit: true }); await assert.rejects(s.run()); assert.equal(s.calls.length, 2); assert.equal(s.executions(), 0);
});
test('altered permit request, manifest and secret set cannot execute', async t => {
  for (const response of [{ ...permit, requestDigest: 'e'.repeat(64) }, { ...permit, request: { ...request, environment: 'other' } },
    { ...permit, manifest: { ...manifest, version: '1.0.1' } }, { ...permit, secrets: {} },
    { ...permit, secrets: { ...permit.secrets, EXTRA_SECRET: 'no' } }]) {
    const s = await scenario(t, { response }); await assert.rejects(s.run(), /SBA_WORKFLOW_REJECTED/); assert.equal(s.executions(), 0);
  }
});
test('failed and unknown business results remain failed and unknown in uploaded envelope', async t => {
  for (const businessStatus of ['failed', 'unknown']) {
    const s = await scenario(t, { businessStatus }); assert.equal((await s.run()).result.status, businessStatus);
  }
});
