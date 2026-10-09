import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';
import { previewManifest, previewRequest } from './sba-preview-fixture.mjs';
import { applicationEnvironment } from '../src/sba/runner.mjs';

const manifest = () => ({ ...previewManifest(), actions: { ...previewManifest().actions, repair: { timeoutSeconds: 300 } },
  secrets: ['CLOUDFLARE_API_TOKEN', 'ADMIN_BOOTSTRAP_PASSWORD'],
  repairs: [{ id: 'admin-publish', name: '补发管理后台', fromErrorCodes: ['NACCOUNT_ADMIN_PUBLISH_FAILED'], secretNames: ['CLOUDFLARE_API_TOKEN'] }] });
const request = () => ({ ...previewRequest(), action: 'repair', environment: 'production',
  context: { repairId: 'admin-publish', parentTaskId: 'dc-' + '1'.repeat(32), parentRunId: 42,
    requestDigest: 'c'.repeat(64), resultDigest: 'd'.repeat(64), errorCode: 'NACCOUNT_ADMIN_PUBLISH_FAILED' } });
const result = () => {
  const { schemaVersion, taskId, action, sourceSha, applicationVersion } = request();
  return { schemaVersion, taskId, action, sourceSha, applicationVersion, status: 'succeeded',
    checks: ['repair-completed', 'data-preserved', 'unchanged-resources-verified', 'service-ready'].map(id => ({ id, passed: true })) };
};

test('repair explicitly declares capabilities and requires parent evidence fields', () => {
  assert.deepEqual(validateManifest(manifest()), manifest());
  assert.deepEqual(validateRequest(request(), manifest()), request());
  assert.deepEqual(validateResult(result(), request()), result());
  assert.deepEqual(validateManifest(previewManifest()), previewManifest());
});

test('repair declaration rejects missing or inconsistent action, duplicate IDs and undeclared secrets', () => {
  for (const change of [m => delete m.actions.repair, m => delete m.repairs, m => { m.repairs = []; },
    m => m.repairs.push(m.repairs[0]), m => { m.repairs[0].name = ''; }, m => { m.repairs[0].fromErrorCodes = ['bad']; },
    m => { m.repairs[0].secretNames = ['OTHER_SECRET']; }, m => { m.repairs[0].secretNames.push('CLOUDFLARE_API_TOKEN'); },
    m => { m.repairs[0].unexpected = true; }, m => { m.schemaVersion = 2; }]) {
    const value = manifest(); change(value); assert.throws(() => validateManifest(value));
  }
});

test('repair rejects missing or malformed parent evidence and undeclared error codes', () => {
  for (const change of [r => delete r.context, r => { r.context.parentTaskId = r.taskId; },
    r => { r.context.parentTaskId = 'arbitrary'; }, r => { r.context.parentTaskId = ['dc-' + '1'.repeat(32)]; }, r => { r.context.parentRunId = 0; },
    r => { r.context.parentRunId = Number.MAX_SAFE_INTEGER + 1; }, r => { r.context.requestDigest = 'bad'; },
    r => { r.context.resultDigest = null; }, r => { r.context.errorCode = 'OTHER_FAILURE'; },
    r => { r.context.repairId = 'unknown'; }, r => { r.context.rawLog = 'private'; },
    r => { r.sourceSha = r.previous.sourceSha; }, r => { r.applicationVersion = r.previous.applicationVersion; },
    r => { r.previous = null; }]) {
    const value = request(); change(value); assert.throws(() => validateRequest(value, manifest()));
  }
});

test('repair success requires every preservation and readiness check; unknown is not upgraded', () => {
  for (const check of result().checks) {
    const value = result(); value.checks = value.checks.filter(row => row.id !== check.id);
    assert.throws(() => validateResult(value, request()));
  }
  const unverified = { ...result(), status: 'deployed-unverified' };
  assert.throws(() => validateResult(unverified, request()));
  const unknown = { ...result(), status: 'unknown', checks: [], errorCode: 'NACCOUNT_ADMIN_PUBLISH_WRANGLER_DEPLOY_CF_10021' };
  assert.deepEqual(validateResult(unknown, request()), unknown);
});

test('repair contract does not change deploy, update or verification identity requirements', () => {
  const value = request(); value.action = 'verify';
  assert.throws(() => validateRequest(value, manifest()));
  value.action = 'deploy'; value.previous = null;
  assert.throws(() => validateRequest(value, manifest()));
  assert.throws(() => validateRequest(request(), previewManifest()));
});

test('repair subprocess receives only its declared secrets, never bootstrap or control credentials', () => {
  const value = applicationEnvironment({ CLOUDFLARE_API_TOKEN: 'fixture-token', ADMIN_BOOTSTRAP_PASSWORD: 'must-not-inherit',
    SBA_GITHUB_TOKEN: 'control', GITHUB_TOKEN: 'control', PATH: 'fixture-path' }, manifest(), 'fixture-temp', request());
  assert.equal(value.CLOUDFLARE_API_TOKEN, 'fixture-token');
  for (const name of ['ADMIN_BOOTSTRAP_PASSWORD', 'SBA_GITHUB_TOKEN', 'GITHUB_TOKEN']) assert.equal(Object.hasOwn(value, name), false);
  assert.doesNotThrow(() => applicationEnvironment({ CLOUDFLARE_API_TOKEN: 'fixture-token' }, manifest(), 'fixture-temp', request()));
  assert.throws(() => applicationEnvironment({}, manifest(), 'fixture-temp', request()));
});
