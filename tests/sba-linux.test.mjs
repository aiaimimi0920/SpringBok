import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LINUX_RUNTIME, WINDOWS_RUNTIME } from '../src/sba/runtime.mjs';
import { executeCheckout, invokePowerShell, nativePowerShell, applicationEnvironment } from '../src/sba/runner.mjs';

const native = process.env.SBA_NATIVE_LINUX_TEST === 'yes';
const manifest = { schemaVersion: 3, id: 'sample-app', name: 'Synthetic Linux', version: '2.0.0', entrypoint: 'entry.ps1', runtime: LINUX_RUNTIME,
  actions: Object.fromEntries(['deploy', 'update', 'verify', 'preview', 'destroy-preview'].map(action => [action, { timeoutSeconds: 30 }])), secrets: ['DEPLOY_TOKEN'] };
const script = `param([string]$RequestPath,[string]$ResultPath)
$ErrorActionPreference='Stop'
$request=[IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
if ($env:GITHUB_TOKEN -or $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN -or $env:NODE_OPTIONS) { exit 7 }
if ($env:DEPLOY_TOKEN -ne 'synthetic-only') { exit 8 }
$checks=@(@{id='native-ready';passed=$true})
if ($request.action -eq 'update') {
  $data=[IO.File]::ReadAllText($request.configuration.dataPath) | ConvertFrom-Json
  if ($data.users[0].value -ne 'preserve-me') { exit 9 }
  $data.schemaVersion=2
  [IO.File]::WriteAllText($request.configuration.dataPath,($data | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $checks=@(@{id='backup-created';passed=$true},@{id='data-preserved';passed=$true})
}
$result=@{schemaVersion=3;taskId=$request.taskId;action=$request.action;sourceSha=$request.sourceSha;applicationVersion=$request.applicationVersion;status='succeeded';checks=$checks}
[IO.File]::WriteAllText($ResultPath,($result | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
`;
async function fixture(t) {
  assert.equal(process.platform, 'linux', 'native Linux job must not silently skip on another host');
  const base = await mkdtemp(join(process.env.RUNNER_TEMP, 'sba linux '));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'checkout with spaces'); await mkdir(join(root, '.sba'), { recursive: true });
  await writeFile(join(root, '.sba/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, '.sba/entry.ps1'), script);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']); git(['remote', 'add', 'origin', 'https://github.com/owner/application.git']);
  git(['add', '.sba']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic Linux fixture']);
  const request = { schemaVersion: 3, taskId: 'task-linux', action: 'deploy', repository: 'owner/application', sourceSha: git(['rev-parse', 'HEAD']),
    applicationId: manifest.id, applicationVersion: manifest.version, environment: 'testing', configuration: {}, previous: null };
  return { base, root, request };
}

test('native Linux interpreter is exact and never accepts the Windows runtime on this host', { skip: !native }, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(nativePowerShell(LINUX_RUNTIME), join(process.env.RUNNER_TEMP, 'sba-pwsh-7.6.9/pwsh'));
  assert.throws(() => nativePowerShell(WINDOWS_RUNTIME));
  assert.throws(() => nativePowerShell({ ...LINUX_RUNTIME, powershell: '7' }));
});

test('native Linux exact checkout executes deploy, verify and data-preserving update with bound receipts', { skip: !native }, async t => {
  const f = await fixture(t);
  for (const action of ['deploy', 'verify', 'update']) {
    const dataPath = join(f.base, `${action} 数据.json`), data = { schemaVersion: 1, users: [{ value: 'preserve-me' }] };
    await writeFile(dataPath, JSON.stringify(data));
    const request = { ...f.request, taskId: 'task-linux-' + action, action, configuration: { dataPath },
      previous: action === 'deploy' ? null : { sourceSha: action === 'update' ? 'b'.repeat(40) : f.request.sourceSha, applicationVersion: action === 'update' ? '1.0.0' : manifest.version } };
    const output = await executeCheckout({ checkout: f.root, request, tempRoot: f.base,
      environment: { ...process.env, DEPLOY_TOKEN: 'synthetic-only', GITHUB_TOKEN: 'never-pass', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'never-pass' } });
    assert.equal(output.result.status, 'succeeded'); assert.equal(output.result.action, action);
    assert.equal(output.result.sourceSha, f.request.sourceSha);
    const bytes = await readFile(output.receiptPath);
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.doesNotMatch(bytes.toString(), /synthetic-only|never-pass/);
    assert.deepEqual(JSON.parse(bytes), output.result);
    assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')), { ...data, schemaVersion: action === 'update' ? 2 : 1 });
  }
});

test('Linux timeout kills the ordinary descendant process group and still returns unknown execution', { skip: !native, timeout: 30000 }, async t => {
  const f = await fixture(t), launcher = join(f.base, 'child launcher.cjs'), pidsPath = join(f.base, 'pids.json');
  await writeFile(launcher, `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const requestPath = join(f.base, 'request input.json'), resultPath = join(f.base, 'result output.json'), entrypoint = join(f.base, 'timeout script.ps1');
  await writeFile(requestPath, JSON.stringify({ node: process.execPath, launcher, pidsPath }));
  await writeFile(entrypoint, `param([string]$RequestPath,[string]$ResultPath)
$r=[IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
& $r.node $r.launcher $r.pidsPath
`);
  const execution = await invokePowerShell({ root: f.root, manifest, entrypoint, requestPath, resultPath, timeoutSeconds: 5,
    environment: applicationEnvironment({ ...process.env, DEPLOY_TOKEN: 'synthetic-only' }, manifest, f.base) });
  assert.deepEqual(execution, { exitCode: null, timedOut: true });
  const pids = JSON.parse(await readFile(pidsPath, 'utf8')); assert.equal(pids.length, 2);
  for (const pid of pids) {
    let state;
    try { state = (await readFile(`/proc/${pid}/stat`, 'utf8')).replace(/^\d+ \(.*\) /, '')[0]; }
    catch (error) { assert.equal(error.code, 'ENOENT'); continue; }
    assert.equal(state, 'Z', 'a live descendant must not survive group termination');
  }
});
