import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';
import { executeCheckout } from '../src/sba/runner.mjs';
import { previewManifest, previewRequest, previewResult } from './sba-preview-fixture.mjs';

test('v3 preview requires explicit capabilities and disjoint bound source and destination inventories', () => {
  const manifest = previewManifest(), request = previewRequest();
  assert.deepEqual(validateRequest(request, manifest), request);
  const legacy = { ...manifest, schemaVersion: 2, actions: Object.fromEntries(Object.entries(manifest.actions).filter(([key]) => !['preview', 'destroy-preview'].includes(key))) };
  assert.throws(() => validateRequest(request, legacy));
  for (const edit of [m => { delete m.actions.preview; }, m => { m.actions.preview.command = 'shell'; }, m => { m.schemaVersion = 4; }]) {
    const m = previewManifest(); edit(m); assert.throws(() => validateManifest(m));
  }
  for (const edit of [r => { r.context.source.sourceSha = 'c'.repeat(40); }, r => { r.context.source.environment = r.environment; },
    r => { r.context.resources = r.context.source.resources; }, r => { r.context.resources.push(r.context.resources[0]); },
    r => { r.context.urls = ['http://unsafe.invalid']; }, r => { r.context.urls = ['https://unbound.invalid']; },
    r => { r.context.source.resultDigest = 'unverified'; }, r => { r.context.source.extra = true; }, r => { r.context.resources[0].kind = 'container'; }]) {
    const r = previewRequest(); edit(r); assert.throws(() => validateRequest(r, manifest));
  }
});
test('preview success requires complete snapshot, migration, isolation and inventory proof; cleanup cannot claim partial success', () => {
  const request = previewRequest(); assert.deepEqual(validateResult(previewResult(), request), previewResult());
  for (const edit of [r => { delete r.lifecycle; }, r => { r.lifecycle.snapshot = null; }, r => { r.lifecycle.urls = []; },
    r => { r.lifecycle.resources[0].status = 'unknown'; }, r => { r.lifecycle.resources.pop(); }, r => { r.checks.pop(); },
    r => { r.checks[0].passed = false; }, r => { r.lifecycle.resources[0].key = 'production'; }]) {
    const r = previewResult(); edit(r); assert.throws(() => validateResult(r, request));
    r.status = 'deployed-unverified'; assert.throws(() => validateResult(r, request));
  }
  const remove = { ...request, action: 'destroy-preview', previous: { sourceSha: request.sourceSha, applicationVersion: request.applicationVersion },
    context: { instanceId: request.taskId, previewTaskId: request.taskId, resultDigest: 'e'.repeat(64), resources: request.context.resources } };
  validateRequest(remove, previewManifest());
  const result = { ...previewResult(remove), lifecycle: { resources: remove.context.resources.map(row => ({ key: row.key, status: 'removed' })) } };
  validateResult(result, remove);
  result.lifecycle.resources[0].status = 'unknown'; assert.throws(() => validateResult(result, remove));
  result.status = 'unknown'; validateResult(result, remove);
  remove.context.source = request.context.source; assert.throws(() => validateRequest(remove, previewManifest()));
});
test('v3 update requires backup and preserved-data receipts without changing legacy v2 result semantics', () => {
  const { context, ...base } = previewRequest(), request = { ...base, action: 'update' };
  validateRequest(request, previewManifest());
  const { lifecycle, ...proof } = previewResult();
  const result = { ...proof, action: 'update' };
  assert.throws(() => validateResult(result, request));
  result.checks = ['backup-created', 'data-preserved'].map(id => ({ id, passed: true })); validateResult(result, request);
  result.checks.pop(); result.status = 'deployed-unverified'; assert.throws(() => validateResult(result, request));
  validateResult({ ...result, schemaVersion: 2 }, { ...request, schemaVersion: 2 });
});
test('native PowerShell copies and migrates a snapshot, updates fresh production data, and deletes only the test copy', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || 'C:/Users/Public/nas_home/AI/GameEditor/linshi', 'sba-preview-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'); await mkdir(join(checkout, '.sba'), { recursive: true });
  const source = join(root, 'production.json'), target = join(root, 'preview.json'), backup = join(root, 'production-backup.json');
  const original = { schemaVersion: 1, users: [{ id: 'existing-user', value: 'preserve-me' }] };
  await writeFile(source, JSON.stringify(original), 'utf8');
  await writeFile(join(checkout, '.sba', 'manifest.json'), JSON.stringify(previewManifest()), 'utf8');
  await writeFile(join(checkout, '.sba', 'entry.ps1'), `param([string]$RequestPath,[string]$ResultPath)
$ErrorActionPreference = 'Stop'
$r = [IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
$checks = @(); $lifecycle = $null
if ($r.action -eq 'preview') {
  $before = [IO.File]::ReadAllText($r.context.source.configuration.dataPath)
  [IO.File]::Copy($r.context.source.configuration.dataPath, $r.configuration.dataPath, $false)
  $data = [IO.File]::ReadAllText($r.configuration.dataPath) | ConvertFrom-Json
  $data.schemaVersion = 2
  [IO.File]::WriteAllText($r.configuration.dataPath, ($data | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  if ($before -ne [IO.File]::ReadAllText($r.context.source.configuration.dataPath)) { exit 7 }
  foreach ($id in @('snapshot-copied','migration-verified','source-unchanged','side-effects-isolated')) { $checks += @{id=$id;passed=$true} }
  $digest = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($before))).Replace('-','').ToLowerInvariant()
  $lifecycle = @{resources=@($r.context.resources | ForEach-Object { @{key=$_.key;status='created'} });urls=@($r.context.urls);snapshot=@{id=$digest;createdAt=1791459200000}}
} elseif ($r.action -eq 'update') {
  [IO.File]::Copy($r.configuration.dataPath, $r.configuration.backupPath, $false)
  $data = [IO.File]::ReadAllText($r.configuration.dataPath) | ConvertFrom-Json
  $data.schemaVersion = 2
  [IO.File]::WriteAllText($r.configuration.dataPath, ($data | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  $checks = @(@{id='backup-created';passed=$true},@{id='data-preserved';passed=($data.users.Count -eq 2)})
} elseif ($r.action -eq 'destroy-preview') {
  [IO.File]::Delete($r.configuration.dataPath)
  $checks = @(@{id='test-copy-removed';passed=(!$r.context.PSObject.Properties['source'] -and !(Test-Path -LiteralPath $r.configuration.dataPath))})
  $lifecycle = @{resources=@($r.context.resources | ForEach-Object { @{key=$_.key;status='removed'} })}
} else { exit 8 }
$result = @{schemaVersion=3;taskId=$r.taskId;action=$r.action;sourceSha=$r.sourceSha;applicationVersion=$r.applicationVersion;status='succeeded';checks=$checks}
if ($null -ne $lifecycle) { $result.lifecycle = $lifecycle }
[IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
`, 'utf8');
  const git = args => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.name', 'SBA Test']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'core.autocrlf', 'false']);
  git(['remote', 'add', 'origin', 'https://github.com/example/application.git']); git(['add', '.sba']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic preview']);
  const request = previewRequest(); request.sourceSha = git(['rev-parse', 'HEAD']); request.configuration = { dataPath: target }; request.context.source.configuration = { dataPath: source };
  const run = async input => { const output = await executeCheckout({ checkout, request: input, tempRoot: root, environment: process.env }); assert.equal(output.result.status, 'succeeded', JSON.stringify(output.result)); return output; };
  await run(request);
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { ...original, schemaVersion: 2 });
  const fresh = { ...original, users: [...original.users, { id: 'arrived-after-preview', value: 'keep-latest' }] };
  await writeFile(source, JSON.stringify(fresh), 'utf8');
  const { context, ...update } = request;
  await run({ ...update, taskId: 'dc-' + '3'.repeat(32), action: 'update', environment: 'production', configuration: { dataPath: source, backupPath: backup } });
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { ...fresh, schemaVersion: 2 });
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), fresh);
  await run({ ...request, taskId: 'dc-' + '4'.repeat(32), action: 'destroy-preview', previous: { sourceSha: request.sourceSha, applicationVersion: request.applicationVersion },
    context: { instanceId: request.taskId, previewTaskId: request.taskId, resultDigest: 'e'.repeat(64), resources: request.context.resources } });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), { ...fresh, schemaVersion: 2 });
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), fresh);
});
