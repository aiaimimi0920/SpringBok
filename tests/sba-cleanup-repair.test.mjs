import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';
import { previewManifest, previewRequest } from './sba-preview-fixture.mjs';
import { repairCleanupContext } from '../src/sba/cleanup-repair.mjs';
import { confirmedVersion } from '../public/cloud-admin/service-model.mjs';

const manifest = () => ({ ...previewManifest(), version: '3.0.0', actions: { ...previewManifest().actions, repair: { timeoutSeconds: 300 } },
  repairs: [{ id: 'cleanup-copy', name: '清理测试副本', fromErrorCodes: ['SHARED_OR_UNVERIFIED'], fromActions: ['destroy-preview', 'repair'], secretNames: [] }] });
const request = () => {
  const parent = previewRequest();
  return { ...parent, action: 'repair', taskId: 'dc-' + '3'.repeat(32), sourceSha: 'c'.repeat(40), applicationVersion: '3.0.0',
    previous: { sourceSha: parent.sourceSha, applicationVersion: parent.applicationVersion }, context: {
      repairId: 'cleanup-copy', parentTaskId: 'dc-' + '4'.repeat(32), parentRunId: 42, requestDigest: 'd'.repeat(64), resultDigest: 'e'.repeat(64),
      errorCode: 'SHARED_OR_UNVERIFIED', cleanup: { sourceSha: parent.sourceSha, applicationVersion: parent.applicationVersion,
        context: { instanceId: parent.taskId, previewTaskId: parent.taskId, resultDigest: 'f'.repeat(64), resources: parent.context.resources } } } };
};
const result = () => {
  const r = request(); return { schemaVersion: 3, taskId: r.taskId, action: r.action, sourceSha: r.sourceSha, applicationVersion: r.applicationVersion,
    status: 'succeeded', checks: [{ id: 'repair-completed', passed: true }], lifecycle: {
      resources: r.context.cleanup.context.resources.map(row => ({ key: row.key, status: 'removed' })) } };
};

test('cleanup repair has a distinct removed lifecycle and never claims candidate code was deployed', () => {
  assert.deepEqual(validateManifest(manifest()), manifest()); assert.deepEqual(validateRequest(request(), manifest()), request());
  assert.deepEqual(validateResult(result(), request()), result());
  assert.equal(confirmedVersion({ status: 'deleted', job: { status: 'succeeded', request: request() } }), null);
  assert.deepEqual(repairCleanupContext(request()), request().context.cleanup);
});

test('cleanup context and declarations reject mixed scopes, unknown baselines and fabricated identities', () => {
  for (const mutate of [r => delete r.context.cleanup, r => r.context.cleanup.sourceSha = r.sourceSha,
    r => r.context.cleanup.applicationVersion = '9.0.0', r => r.context.cleanup.context.previewTaskId = r.context.parentTaskId,
    r => r.context.cleanup.context.instanceId = r.taskId, r => r.context.cleanup.context.instanceId = r.context.parentTaskId,
    r => r.context.cleanup.context.extra = true,
    r => r.context.preview = {}, r => r.context.previewBaseline = {}]) {
    const value = request(); mutate(value); assert.throws(() => validateRequest(value, manifest()));
  }
  for (const actions of [['destroy-preview', 'preview'], ['destroy-preview', 'deploy']]) {
    const value = manifest(); value.repairs[0].fromActions = actions; assert.throws(() => validateManifest(value));
  }
});

test('cleanup repair success requires full removal evidence and repair check, never readiness fiction', () => {
  for (const mutate of [r => delete r.lifecycle, r => r.lifecycle.resources[0].status = 'created',
    r => r.lifecycle.resources[0].status = 'unknown', r => r.lifecycle.urls = [], r => r.checks = [],
    r => r.status = 'deployed-unverified']) {
    const value = result(); mutate(value); assert.throws(() => validateResult(value, request()));
  }
});
