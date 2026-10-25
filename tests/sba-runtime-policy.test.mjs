import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedSbaPolicy, sbaRequest, sbaExecutorTransition } from '../cloud/sba-control.mjs';
const sha = 'a'.repeat(40), linuxSha = 'c'.repeat(40);
const windows = { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' };
const linux = { runner: 'ubuntu-24.04', powershell: '7.6.9', python: '3.12', node: '22' };
const policy = { github: { repository: 'owner/executor', repositoryId: 123, applicationRepository: 'owner/application',
  workflowId: 99, workflowPath: '.github/workflows/sba-execute.yml', executorSha: sha, ref: `sba-executor-${sha}` },
  sourceSha: 'b'.repeat(40), environment: 'testing', configuration: {}, secretNames: ['DEPLOY_TOKEN'], runnerOrigin: 'https://runner.example.invalid' };
const env = { ENABLE_SBA: 'yes', SBA_TASKS: {}, SBA_GITHUB_TOKEN: 'synthetic-executor', SBA_POLICY: JSON.stringify(policy),
  ADMIN_ORIGIN: 'https://admin.example.invalid', SBA_CONNECTED_EXECUTOR_SHA: 'd'.repeat(40),
  SBA_CONNECTED_LINUX_EXECUTOR: JSON.stringify({ workflowId: 100, executorSha: linuxSha }) };
const manifest = runtime => ({ schemaVersion: 2, id: 'sample-app', name: 'Sample', version: '1.0.0', entrypoint: 'entry.ps1', runtime,
  actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 60 } }, secrets: ['DEPLOY_TOKEN'] });

test('connected executor selection is bound to approved runtime and keeps the Windows pin independent', () => {
  const win = connectedSbaPolicy(env, windows), lin = connectedSbaPolicy(env, linux);
  assert.equal(win.github.executorSha, 'd'.repeat(40)); assert.equal(win.github.workflowId, 99);
  assert.equal(lin.github.executorSha, linuxSha); assert.equal(lin.github.workflowId, 100);
  assert.equal(lin.github.workflowPath, '.github/workflows/sba-execute-linux.yml');
  assert.equal(lin.github.repository, policy.github.repository); assert.equal(lin.github.repositoryId, 123);
  assert.equal(JSON.parse(env.SBA_POLICY).github.executorSha, sha);
  assert.notDeepEqual(win, lin);
  assert.equal(sbaRequest(lin, 'task-linux', manifest(linux)).applicationId, 'sample-app');
  assert.throws(() => sbaRequest(win, 'task-linux', manifest(linux)));
  assert.throws(() => sbaRequest(lin, 'task-windows', manifest(windows)));
});

test('Linux cannot fall back to Windows or select an arbitrary workflow through configuration', () => {
  for (const value of [undefined, '', '{}', JSON.stringify({ workflowId: 100, executorSha: 'main' }),
    JSON.stringify({ workflowId: 100, executorSha: linuxSha, workflowPath: '.github/workflows/untrusted.yml' })]) {
    assert.throws(() => connectedSbaPolicy({ ...env, SBA_CONNECTED_LINUX_EXECUTOR: value }, linux));
  }
  assert.throws(() => connectedSbaPolicy(env, { ...linux, powershell: '5.1' }));
  const lin = connectedSbaPolicy(env, linux), nextSha = 'e'.repeat(40);
  const next = sbaExecutorTransition({ ...env, SBA_RECOVERY_EXECUTOR_SHA: nextSha }, lin, nextSha);
  assert.equal(next.github.workflowPath, lin.github.workflowPath); assert.equal(next.github.workflowId, lin.github.workflowId);
  assert.equal(next.github.executorSha, nextSha);
});
