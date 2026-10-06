import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';

const manifest = () => ({ schemaVersion: 2, id: 'sample-app', name: 'Sample App', version: '1.2.0', entrypoint: 'springbok.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 3600 }, update: { timeoutSeconds: 3600 }, verify: { timeoutSeconds: 120 } }, secrets: ['CLOUDFLARE_API_TOKEN'] });
const request = () => ({ schemaVersion: 2, taskId: 'sba-test-01', action: 'deploy', repository: 'example/sample', sourceSha: 'a'.repeat(40),
  applicationId: 'sample-app', applicationVersion: '1.2.0', environment: 'acceptance', configuration: {}, previous: null });
const result = () => ({ schemaVersion: 2, taskId: 'sba-test-01', action: 'deploy', sourceSha: 'a'.repeat(40), applicationVersion: '1.2.0', status: 'succeeded', checks: [{ id: 'application-ready', passed: true }] });

test('v2 explicit contract and request are copied without caller mutation', () => {
  const m = manifest(), r = request(), accepted = validateManifest(m), input = validateRequest(r, m);
  accepted.actions.deploy.timeoutSeconds = 1; input.configuration.changed = true;
  assert.equal(m.actions.deploy.timeoutSeconds, 3600); assert.deepEqual(r.configuration, {});
  assert.deepEqual(validateResult(result(), r), result());
});

test('legacy manifests, path escapes, shell text and unsupported runtimes fail closed', () => {
  for (const edit of [m => {m.schemaVersion = 1;}, m => {m.entrypoint = '../deploy.ps1';}, m => {m.entrypoint = 'C:\\deploy.ps1';},
    m => {m.entrypoint = 'deploy.ps1;whoami';}, m => {m.runtime.runner = 'self-hosted';}, m => {m.actions.deploy.command = 'anything';},
    m => {m.actions.update.timeoutSeconds = 0;}, m => {m.actions.verify.timeoutSeconds = 3601;},
    m => {m.secrets = ['GITHUB_TOKEN'];}, m => {m.secrets.push(m.secrets[0]);}, m => {m.actions.shell = {};}, m => {m.version = 'latest';}]) {
    const m = manifest(); edit(m); assert.throws(() => validateManifest(m));
  }
});

test('updates use numeric stable versions and immutable different commit identities', () => {
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  for (const version of ['v1.2.0', '1.2', '01.2.0', '1.2.0-beta', '1.2.0+sha']) assert.throws(() => compareVersions(version, '1.2.0'));
  const r = {...request(), action: 'update', previous: {sourceSha: 'b'.repeat(40), applicationVersion: '1.1.0'}};
  assert.deepEqual(validateRequest(r, manifest()), r);
  for (const edit of [x => {x.previous.applicationVersion = '1.2.0';}, x => {x.previous.applicationVersion = '2.0.0';},
    x => {x.sourceSha = x.previous.sourceSha;}, x => {x.sourceSha = 'main';}, x => {x.applicationId = 'other-app';},
    x => {x.repository = 'https://github.com/example/sample';}, x => {x.action = 'migrate';}]) {
    const x = structuredClone(r); edit(x); assert.throws(() => validateRequest(x, manifest()));
  }
});

test('verification is bound to the exact currently selected deployed release', () => {
  const r = {...request(), action: 'verify', previous: {sourceSha: 'a'.repeat(40), applicationVersion: '1.2.0'}};
  assert.deepEqual(validateRequest(r, manifest()), r);
  r.previous.sourceSha = 'b'.repeat(40); assert.throws(() => validateRequest(r, manifest()));
});

test('results reject replay across tasks, false success, arbitrary output and unbounded errors', () => {
  for (const edit of [x => {x.taskId = 'other-task';}, x => {x.sourceSha = 'b'.repeat(40);}, x => {x.action = 'update';},
    x => {x.checks = [];}, x => {x.checks[0].passed = false;}, x => {x.checks.push(x.checks[0]);},
    x => {x.stdout = 'credential';}, x => {x.errorCode = 'secret value';}, x => {x.status = 'accepted';}]) {
    const x = result(); edit(x); assert.throws(() => validateResult(x, request()));
  }
  for (const status of ['failed', 'unknown', 'deployed-unverified']) {
    assert.equal(validateResult({...result(), status, checks: []}, request()).status, status);
  }
});
