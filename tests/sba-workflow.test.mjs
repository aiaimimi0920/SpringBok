import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sbaDigest, canonicalSba } from '../cloud/sba-control.mjs';
import { workflowInput, runSbaWorkflow } from '../scripts/sba-workflow.mjs';
import { sourceWant, SOURCE_CONTENT_TYPE } from '../src/sba/source.mjs';
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
  const calls = [], stages = []; let executions = 0;
  const result = { schemaVersion: 2, taskId: request.taskId, action: 'deploy', sourceSha: request.sourceSha, applicationVersion: '1.0.0',
    status: businessStatus, checks: businessStatus === 'succeeded' ? [{ id: 'health-check', passed: true }] : [] };
  const run = () => runSbaWorkflow({ environment: base, tempRoot: root, onStage: stage => stages.push(stage),
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
  return { root, calls, stages, run, executions: () => executions };
}
test('valid permit executes once and writes only bound receipt, not credentials', async t => {
  const s = await scenario(t); const result = await s.run();
  assert.equal(s.executions(), 1); assert.equal(result.result.status, 'succeeded');
  const text = await readFile(join(s.root, 'sba-receipt/receipt.json'), 'utf8');
  assert.doesNotMatch(text, /synthetic-(control|deployment)-token|synthetic-oidc|secrets/);
  assert.equal(JSON.parse(text).permitId, permit.permitId);
  assert.deepEqual(s.stages, ['input', 'workspace', 'checkout', 'oidc', 'permit', 'execution', 'receipt']);
});
test('lost permit response never retries or executes', async t => {
  const s = await scenario(t, { failPermit: true }); await assert.rejects(s.run()); assert.equal(s.calls.length, 2); assert.equal(s.executions(), 0);
  assert.deepEqual(s.stages, ['input', 'workspace', 'checkout', 'oidc', 'permit']);
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

test('native checkout reaches the fixed executor SHA guard with isolated Git config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'springbok-workflow-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? process.env.Path, SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull, GIT_TERMINAL_PROMPT: '0' };
  const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  assert.notEqual(git(['rev-parse', 'HEAD']), sha);
  let requests = 0, executions = 0;
  await assert.rejects(runSbaWorkflow({
    environment: { ...process.env, ...base, GITHUB_WORKSPACE: root,
      GIT_CONFIG_GLOBAL: join(root, 'untrusted-config'), GIT_DIR: join(root, 'not-a-repository'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.rev-parse', GIT_CONFIG_VALUE_0: '!exit 99' },
    tempRoot: root,
    fetchImpl: async () => { requests++; throw new Error('unexpected-network'); },
    execute: async () => { executions++; throw new Error('unexpected-execution'); },
  }), /^Error: SBA_WORKFLOW_REJECTED$/);
  assert.equal(requests, 0); assert.equal(executions, 0);
});
test('CLI failure logs only the fixed stage, never input or raw error', () => {
  let failure;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/sba-workflow.mjs', import.meta.url))], {
      env: { ...process.env, ...base, SBA_EXECUTOR_SHA: 'synthetic-sensitive-input', CLOUDFLARE_API_TOKEN: 'synthetic-never-log-secret' },
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.status, 1);
  assert.equal(failure.stdout, '');
  assert.equal(failure.stderr.trim(), `SBA_WORKFLOW_UNCONFIRMED stage=${process.platform === 'win32' ? 'input' : 'platform'}`);
});


async function nativeSource(t) {
  const root = await mkdtemp(join(tmpdir(), 'springbok-source-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'fixture'); await mkdir(fixture); await mkdir(join(fixture, '.sba'));
  await writeFile(join(fixture, '.sba/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(fixture, '.sba/entry.ps1'), '# synthetic fixture only\nexit 0\n');
  const env = { PATH: process.env.PATH ?? process.env.Path, SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull, GIT_TERMINAL_PROMPT: '0' };
  const git = (args, input) => execFileSync('git', args, { cwd: fixture, env, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  git(['init', '--quiet']); git(['add', '.sba']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  const sourceSha = git(['rev-parse', 'HEAD']).toString().trim();
  const bytes = git(['upload-pack', '--stateless-rpc', fixture], sourceWant(sourceSha));
  const input = { ...request, sourceSha }, digest = await sbaDigest(input);
  const environment = { ...process.env, ...base, SBA_EXECUTOR_SHA: sourceSha, GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha,
    GITHUB_REF: `refs/tags/sba-executor-${sourceSha}`, GITHUB_WORKFLOW_REF: `owner/executor/.github/workflows/sba-execute.yml@refs/tags/sba-executor-${sourceSha}`,
    GITHUB_WORKSPACE: fixture, SBA_REQUEST_JSON: canonicalSba(input), SBA_REQUEST_SHA256: digest };
  const result = { schemaVersion: 2, taskId: input.taskId, action: input.action, sourceSha, applicationVersion: '1.0.0',
    status: 'succeeded', checks: [{ id: 'synthetic-check', passed: true }] };
  return { root, bytes, input, digest, environment, result };
}
test('native Git upload-pack → broker bytes → strict checkout precedes one-time permit', async t => {
  const x = await nativeSource(t), calls = [];
  let executions = 0;
  const envelope = await runSbaWorkflow({ environment: x.environment, tempRoot: x.root,
    fetchImpl: async (url, options) => {
      calls.push(new URL(url).pathname);
      if (calls.length === 1) return Response.json({ value: 'synthetic-oidc' });
      assert.equal(options.headers.authorization, 'Bearer synthetic-oidc');
      assert.deepEqual(JSON.parse(options.body), { taskId: x.input.taskId, requestDigest: x.digest });
      if (calls.length === 2) return new Response(x.bytes, { headers: { 'content-type': SOURCE_CONTENT_TYPE } });
      assert.equal(calls.length, 3);
      return Response.json({ ...permit, request: x.input, requestDigest: x.digest });
    },
    execute: async ({ checkout }) => {
      executions++;
      assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), x.input.sourceSha);
      const config = await readFile(join(checkout, '.git/config'), 'utf8');
      assert.match(config, /https:\/\/github\.com\/owner\/application\.git/);
      assert.doesNotMatch(config, /synthetic-oidc|token|extraheader/i);
      return { result: x.result };
    },
  });
  assert.equal(executions, 1); assert.deepEqual(envelope.result, x.result);
  assert.deepEqual(calls, ['/oidc', '/sba/v2/source', '/sba/v2/permit']);
});
test('corrupt or rejected source cannot request permit or execute an application', async t => {
  for (const malformed of ['rejected', 'framing', 'git-object']) {
    const x = await nativeSource(t), calls = []; let executions = 0;
    // 合法 framing/checksum 不等于合法 Git 对象；仍须由原生 Git strict 拒绝。
    const packet = value => Buffer.concat([Buffer.from((value.length + 4).toString(16).padStart(4, '0')), value]);
    const head = Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), Buffer.from('invalid-git-object')]);
    const pack = Buffer.concat([head, createHash('sha1').update(head).digest()]);
    const invalidObject = Buffer.concat([packet(Buffer.from(`shallow ${x.input.sourceSha}\n`)), Buffer.from('0000'),
      packet(Buffer.from('NAK\n')), packet(Buffer.concat([Buffer.from([1]), pack])), Buffer.from('0000')]);
    await assert.rejects(runSbaWorkflow({ environment: x.environment, tempRoot: x.root,
      fetchImpl: async url => { calls.push(new URL(url).pathname);
        if (calls.length === 1) return Response.json({ value: 'synthetic-oidc' });
        assert.equal(calls.length, 2);
        if (malformed === 'rejected') return new Response(null, { status: 403 });
        return new Response(malformed === 'framing' ? 'not-a-git-pack' : invalidObject, { headers: { 'content-type': SOURCE_CONTENT_TYPE } });
      }, execute: async () => { executions++; throw new Error('unexpected-execution'); },
    }), malformed === 'git-object' ? /unpack-objects/ : /SBA_SOURCE_REJECTED/);
    assert.deepEqual(calls, ['/oidc', '/sba/v2/source']); assert.equal(executions, 0);
  }
});
