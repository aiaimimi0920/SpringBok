import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { applicationEnvironment, inspectCheckout, executeCheckout, readExecutionResult, invokePowerShell } from '../src/sba/runner.mjs';

const manifest = {
  schemaVersion: 2, id: 'sample-app', name: 'Sample app', version: '1.0.0', entrypoint: 'springbok.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 1 } },
  secrets: ['DEPLOY_TOKEN'],
};
const request = {
  schemaVersion: 2, taskId: 'task-test', action: 'deploy', repository: 'example/application',
  sourceSha: 'a'.repeat(40), applicationId: manifest.id, applicationVersion: manifest.version,
  environment: 'test', configuration: {}, previous: null,
};
const receipt = input => ({ schemaVersion: 2, taskId: input.taskId, action: input.action,
  sourceSha: input.sourceSha, applicationVersion: input.applicationVersion,
  status: 'deployed-unverified', checks: [{ id: 'published', passed: true }] });
const temporaryRoot = process.env.RUNNER_TEMP || (process.platform === 'win32' ? 'C:/Users/Public/nas_home/AI/GameEditor/linshi' : tmpdir());
async function fixture(t) {
  const base = await mkdtemp(join(temporaryRoot, 'sba-runner-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'checkout');
  await mkdir(join(root, '.sba'), { recursive: true });
  await writeFile(join(root, '.sba', 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, '.sba', 'springbok.ps1'), '# Fixture only\n');
  await writeFile(join(root, 'implementation.txt'), 'original\n');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']);
  git(['config', 'user.name', 'SBA Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['remote', 'add', 'origin', 'https://github.com/example/application.git']);
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return { base, root, git, input: { ...request, sourceSha: git(['rev-parse', 'HEAD']) } };
}

test('checkout requires exact SHA, clean files and the configured GitHub repository', async t => {
  const f = await fixture(t);
  assert.equal((await inspectCheckout(f.root, f.input)).manifest.id, manifest.id);
  await assert.rejects(inspectCheckout(f.root, request));
  await assert.rejects(inspectCheckout(f.root, { ...f.input, repository: 'other/application' }));
  await writeFile(join(f.root, 'untracked.txt'), 'dirty');
  await assert.rejects(inspectCheckout(f.root, f.input));
});

test('application environment excludes control tokens and Actions command files', () => {
  const env = applicationEnvironment({ PATH: 'safe-path', DEPLOY_TOKEN: 'deployment-value',
    GITHUB_TOKEN: 'control-value', ACTIONS_RUNTIME_TOKEN: 'runtime-value', GITHUB_ENV: 'command-file',
    OTHER_SECRET: 'unrelated-value', NODE_OPTIONS: '--import=untrusted.mjs' }, manifest, 'private-temp');
  assert.equal(env.DEPLOY_TOKEN, 'deployment-value');
  assert.equal(env.SBA_EXECUTE, '1');
  assert.equal(env.TEMP, 'private-temp');
  for (const name of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_ENV', 'OTHER_SECRET', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
  assert.throws(() => applicationEnvironment({}, manifest, 'temp'));
  assert.throws(() => applicationEnvironment({ ...env, Path: 'conflicting-path' }, manifest, 'temp'));
  assert.throws(() => applicationEnvironment({ GITHUB_TOKEN: 'never-pass' }, { ...manifest, secrets: ['GITHUB_TOKEN'] }, 'temp'));
  assert.equal(applicationEnvironment({ Path: 'canonical-path', DEPLOY_TOKEN: 'value' }, manifest, 'temp').PATH, 'canonical-path');
});

test('ignored files and index flags cannot hide a dirty source tree', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git', 'info', 'exclude'), 'ignored.txt\n');
  await writeFile(join(f.root, 'ignored.txt'), 'not from GitHub');
  await assert.rejects(inspectCheckout(f.root, f.input), /SBA_RUNNER_PREFLIGHT_FAILED/);
  await rm(join(f.root, 'ignored.txt'));
  f.git(['update-index', '--assume-unchanged', 'implementation.txt']);
  await writeFile(join(f.root, 'implementation.txt'), 'modified\n');
  assert.equal(f.git(['status', '--porcelain']), '');
  await assert.rejects(inspectCheckout(f.root, f.input), /SBA_RUNNER_PREFLIGHT_FAILED/);
});

test('Git environment overrides cannot redirect checkout inspection', async t => {
  const f = await fixture(t), previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.base, 'nonexistent-git-directory');
  try { assert.equal((await inspectCheckout(f.root, f.input)).input.sourceSha, f.input.sourceSha); }
  finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  f.git(['remote', 'set-url', 'origin', 'git@github.com:example/application.git']);
  await assert.rejects(inspectCheckout(f.root, f.input), /^Error: SBA_RUNNER_PREFLIGHT_FAILED$/);
});

test('runner uses fresh external files and accepts only a bound application result', async t => {
  const f = await fixture(t);
  let called = 0;
  const output = await executeCheckout({ checkout: f.root, request: f.input, tempRoot: f.base,
    environment: { DEPLOY_TOKEN: 'not-in-receipt' }, invoke: async options => {
      called++;
      assert.equal(options.timeoutSeconds, 60);
      assert.equal(options.root, f.root);
      assert.deepEqual(JSON.parse(await readFile(options.requestPath, 'utf8')), f.input);
      await writeFile(options.resultPath, JSON.stringify(receipt(f.input)));
      return { exitCode: 0, timedOut: false };
    } });
  assert.equal(called, 1);
  assert.equal(output.result.status, 'deployed-unverified');
  assert.equal((await readFile(output.receiptPath, 'utf8')).includes('not-in-receipt'), false);
  await assert.rejects(executeCheckout({ checkout: f.root, request: f.input, tempRoot: f.root }));
  const repeated = await executeCheckout({ checkout: f.root, request: f.input, tempRoot: f.base,
    environment: { DEPLOY_TOKEN: 'value' }, invoke: async () => ({ exitCode: 0, timedOut: false }) });
  assert.notEqual(repeated.directory, output.directory);
  assert.equal(repeated.result.status, 'unknown');
});

test('timeout, missing/malformed/oversized/mismatched results and false success stay unknown', async t => {
  const f = await fixture(t);
  const path = join(f.base, 'result.json');
  const ok = { exitCode: 0, timedOut: false };
  assert.equal((await readExecutionResult(path, f.input, ok)).status, 'unknown');
  for (const value of ['invalid', ' '.repeat(32769), JSON.stringify({ ...receipt(f.input), sourceSha: 'b'.repeat(40) })]) {
    await writeFile(path, value);
    assert.equal((await readExecutionResult(path, f.input, ok)).status, 'unknown');
  }
  await writeFile(path, JSON.stringify(receipt(f.input)));
  assert.equal((await readExecutionResult(path, f.input, { exitCode: 1 })).errorCode, 'SBA_EXIT_RESULT_MISMATCH');
  assert.equal((await readExecutionResult(path, f.input, { exitCode: 0, timedOut: true })).errorCode, 'SBA_EXECUTION_TIMEOUT');
  assert.equal((await readExecutionResult(path, f.input, { exitCode: null, timedOut: false })).status, 'unknown');
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  assert.equal((await readExecutionResult(path, f.input, ok)).status, 'unknown');
  for (const status of ['failed', 'unknown']) {
    await writeFile(path, JSON.stringify({ ...receipt(f.input), status, checks: [], errorCode: 'APP_STOPPED' }));
    assert.equal((await readExecutionResult(path, f.input, { exitCode: 1 })).status, status);
  }
});

test('linked .sba directories and hardlinked result files are rejected', async t => {
  const f = await fixture(t), outside = join(f.base, 'outside-sba');
  await rename(join(f.root, '.sba'), outside);
  await symlink(outside, join(f.root, '.sba'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectCheckout(f.root, f.input), /SBA_RUNNER_PREFLIGHT_FAILED/);
  const original = join(f.base, 'original-result.json'), result = join(f.base, 'linked-result.json');
  await writeFile(original, JSON.stringify(receipt(f.input)));
  await link(original, result);
  assert.equal((await readExecutionResult(result, f.input, { exitCode: 0 })).status, 'unknown');
});

test('symlink entrypoint is rejected before execution', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const entrypoint = join(f.root, '.sba', 'springbok.ps1');
  await rm(entrypoint);
  await symlink(join(f.base, 'outside.ps1'), entrypoint);
  await writeFile(join(f.base, 'outside.ps1'), '# outside');
  await assert.rejects(inspectCheckout(f.root, f.input));
});

test('timeout waits for close rather than a termination request and bounds a missing close', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const originalSpawn = childProcess.spawn, originalExec = childProcess.execFileSync;
  const child = new EventEmitter();
  let notifyKill;
  const killed = new Promise(resolve => { notifyKill = resolve; });
  child.pid = 123;
  child.kill = () => { notifyKill(); return true; };
  childProcess.spawn = () => child;
  childProcess.execFileSync = command => { assert.equal(command, 'taskkill.exe'); };
  syncBuiltinESMExports();
  const options = { root: 'synthetic', entrypoint: 'synthetic.ps1', requestPath: 'request.json',
    resultPath: 'result.json', environment: {}, timeoutSeconds: 0.001 };
  try {
    let settled = false;
    const pending = invokePowerShell(options).then(result => { settled = true; return result; });
    await killed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'termination request is not process closure');
    child.emit('error', new Error('synthetic kill failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'a kill error must not bypass the close grace');
    child.emit('close', 0);
    assert.deepEqual(await pending, { exitCode: null, timedOut: true });
    // 第二次不发出 close，必须由固定宽限上限结束，不能无限等待。
    const bounded = await invokePowerShell(options);
    assert.deepEqual(bounded, { exitCode: null, timedOut: true });
    child.emit('close', 0);
  } finally {
    child.emit('close', null);
    childProcess.spawn = originalSpawn;
    childProcess.execFileSync = originalExec;
    syncBuiltinESMExports();
  }
});

test('native PowerShell receives spaced paths as arguments and has a bounded timeout', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const entrypoint = join(f.base, 'native fixture.ps1');
  const requestPath = join(f.base, 'request input.json'), resultPath = join(f.base, 'result output.json');
  await writeFile(requestPath, JSON.stringify(f.input));
  await writeFile(entrypoint, 'param([string]$RequestPath,[string]$ResultPath)\n[IO.File]::WriteAllText($ResultPath,[IO.File]::ReadAllText($RequestPath),[Text.UTF8Encoding]::new($false))\n');
  const options = { root: f.root, entrypoint, requestPath, resultPath,
    environment: applicationEnvironment({ ...process.env, DEPLOY_TOKEN: 'synthetic' }, manifest, f.base), timeoutSeconds: 10 };
  assert.deepEqual(await invokePowerShell(options), { exitCode: 0, timedOut: false });
  assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), f.input);
  await writeFile(entrypoint, 'Start-Sleep -Seconds 30\n');
  assert.equal((await invokePowerShell({ ...options, timeoutSeconds: 1 })).timedOut, true);
});

test('native executor validates checkout, invokes the entrypoint once and returns a bound receipt', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.sba', 'springbok.ps1'), `param([string]$RequestPath,[string]$ResultPath)
$input = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$result = [ordered]@{schemaVersion=2; taskId=$input.taskId; action=$input.action; sourceSha=$input.sourceSha; applicationVersion=$input.applicationVersion; status='deployed-unverified'; checks=@(@{id='fixture-ready'; passed=$true})}
[IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
`);
  f.git(['add', '.sba/springbok.ps1']);
  f.git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'native fixture']);
  f.input.sourceSha = f.git(['rev-parse', 'HEAD']);
  const output = await executeCheckout({ checkout: f.root, request: f.input, tempRoot: f.base,
    environment: { ...process.env, DEPLOY_TOKEN: 'synthetic' } });
  assert.equal(output.result.status, 'deployed-unverified');
  assert.equal(output.result.sourceSha, f.input.sourceSha);
  assert.deepEqual(output.result.checks, [{ id: 'fixture-ready', passed: true }]);
  assert.deepEqual(JSON.parse(await readFile(output.receiptPath, 'utf8')), output.result);
});
