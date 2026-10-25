import test from 'node:test';
import assert from 'node:assert/strict';
import { suiteFixture } from './suite-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';
import { LINUX_RUNTIME, WINDOWS_RUNTIME } from '../../src/sba/runtime.mjs';
import { randomUUID } from 'node:crypto';
const linuxSha = 'e'.repeat(40), pin = JSON.stringify({ workflowId: 100, executorSha: linuxSha });
async function linuxFixture(pinValue = pin, overrides = {}) {
  const f = await suiteFixture({ ...overrides, SBA_CONNECTED_LINUX_EXECUTOR: pinValue });
  f.state.manifestOverride.runtime = structuredClone(LINUX_RUNTIME);
  f.state.executorWorkflowId = 100; f.state.executorWorkflowPath = '.github/workflows/sba-execute-linux.yml';
  return f;
}
test('Linux plan, single dispatch, source/OIDC, restart and verify stay bound to the selected executor', async () => {
  const f = await linuxFixture();
  try {
    const plan = await f.preview();
    assert.equal(plan.plan.policy.github.executorSha, linuxSha);
    assert.equal(plan.plan.policy.github.workflowId, 100);
    assert.equal(plan.plan.policy.github.workflowPath, f.state.executorWorkflowPath);
    const tampered = structuredClone(plan); tampered.plan.policy.github.workflowPath = '.github/workflows/sba-execute.yml';
    assert.equal((await f.submit(tampered)).status, 409); assert.equal(f.state.dispatches, 0);
    assert.equal((await f.submit(plan)).status, 200); assert.equal(f.state.dispatches, 1);
    await f.f.restart(); assert.equal((await f.submit(plan)).status, 200); assert.equal(f.state.dispatches, 1);
    const wrong = f.token({ workflow_ref: `owner/executor/.github/workflows/sba-execute.yml@refs/tags/sba-executor-${linuxSha}` });
    assert.equal((await f.machine('permit', { headers: { authorization: `Bearer ${wrong}`, 'content-type': 'application/json' } })).status, 403);
    const source = await f.machine('source'); assert.equal(source.status, 200);
    const permission = await (await f.machine()).json(); assert.equal(permission.manifest.runtime.runner, 'ubuntu-24.04');
    assert.equal((await f.machine()).status, 403); f.complete(permission);
    await f.service('service-state', { instanceId: plan.taskId, reconcile: true });
    const verify = await f.api('verify', { instanceId: plan.taskId, previousTaskId: plan.taskId });
    assert.equal(verify.status, 200, verify.text); assert.equal(f.state.request.action, 'verify');
    assert.equal(f.state.executorSha, linuxSha); assert.equal(f.state.dispatches, 2);
    const checkPermission = await (await f.machine()).json();
    assert.ok(Object.values(checkPermission.secrets).every(value => value === 'verification-not-applicable'));
    f.complete(checkPermission);
    assert.equal((await f.api('state', { taskId: f.state.request.taskId })).status, 200);
  } finally { await f.f.close(); }
});

test('Linux suite preview, cleanup and ordinary update keep runtime, source data and executor identity', async () => {
  const f = await linuxFixture();
  try {
    const first = await f.preview(); await f.submit(first); f.complete(await (await f.machine()).json());
    await f.service('service-state', { instanceId: first.taskId, reconcile: true });
    const draft = await f.service('plan', { action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, environment: 'test-123456789abc' });
    assert.equal(draft.status, 200, draft.text); const preview = draft.json();
    assert.equal(preview.plan.policy.github.workflowId, 100); await f.submit(preview);
    const context = f.state.request.context;
    assert.ok(context.resources.every(r => !context.source.resources.some(old => old.kind === r.kind && old.accountId === r.accountId && old.remoteId === r.remoteId)));
    f.complete(await (await f.machine()).json()); await f.service('service-state', { instanceId: preview.taskId, reconcile: true });
    const cleanup = await f.service('plan', { action: 'destroy-preview', instanceId: preview.taskId, previousTaskId: preview.taskId });
    assert.equal(cleanup.status, 200, cleanup.text); assert.equal(cleanup.json().plan.policy.github.workflowId, 100);
    await f.submit(cleanup.json()); assert.equal(f.state.request.action, 'destroy-preview');
    f.complete(await (await f.machine()).json()); await f.service('service-state', { instanceId: preview.taskId, reconcile: true });
    const update = await f.service('plan', { ...f.input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } });
    assert.equal(update.status, 200, update.text); assert.equal(update.json().plan.policy.github.executorSha, linuxSha);
    await f.submit(update.json()); assert.equal(f.state.request.action, 'update');
    f.complete(await (await f.machine()).json());
  } finally { await f.f.close(); }
});

test('missing Linux pin rejects before cloud writes; ordinary update and rehearsal cannot migrate runtime', async () => {
  const missing = await linuxFixture();
  try {
    missing.state.manifestOverride.runtime = { ...LINUX_RUNTIME, powershell: '5.1' };
    assert.equal((await missing.post(missing.input)).status, 409); assert.equal(missing.state.created.length, 0);
  } finally { await missing.f.close(); }
  const f = await linuxFixture(null);
  try { assert.equal((await f.post(f.input)).status, 409); assert.equal(f.state.created.length, 0); assert.equal(f.state.dispatches, 0); }
  finally { await f.f.close(); }
  const migrated = await linuxFixture();
  try {
    const first = await migrated.preview(); await migrated.submit(first); migrated.complete(await (await migrated.machine()).json());
    await migrated.service('service-state', { instanceId: first.taskId, reconcile: true });
    migrated.state.manifestOverride.runtime = structuredClone(WINDOWS_RUNTIME);
    assert.equal((await migrated.service('plan', { ...migrated.input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } })).status, 409);
    assert.equal((await migrated.service('plan', { action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, environment: 'test-123456789abc' })).status, 409);
    assert.equal(migrated.state.dispatches, 1); assert.equal(migrated.state.created.length, 1);
  } finally { await migrated.f.close(); }
});

test('Linux pin changes invalidate old drafts but preserve accepted task authority and Windows policy', async () => {
  const f = await linuxFixture();
  try {
    const accepted = await f.preview(); await f.submit(accepted);
    const stale = await f.preview(), basePolicy = f.f.bindings.SBA_POLICY;
    const nextSha = '9'.repeat(40);
    f.f.bindings.SBA_CONNECTED_LINUX_EXECUTOR = JSON.stringify({ workflowId: 100, executorSha: nextSha });
    await f.f.restart();
    assert.equal((await f.submit(stale)).status, 409); assert.equal(f.state.dispatches, 1);
    const fresh = await f.preview(); assert.equal(fresh.plan.policy.github.executorSha, nextSha);
    assert.notEqual(fresh.plan.digest, accepted.plan.digest); assert.equal(f.f.bindings.SBA_POLICY, basePolicy);
    const permission = await f.machine(); assert.equal(permission.status, 200);
    f.complete(await permission.json());
    assert.equal((await f.api('reconcile', { taskId: accepted.taskId })).json().job.status, 'succeeded');
    assert.equal(f.state.dispatches, 1);
  } finally { await f.f.close(); }
});

test('Linux single-account reserved preparation recovery refuses pin drift and resumes the original single task only', async () => {
  const f = await linuxFixture();
  try {
    // Preserve the existing recovery scope: suites also claim GitHub and are not single-account recovery.
    f.state.declaration.target = 'cloudflare-workers'; delete f.state.declaration.github;
    f.state.declaration.targets = f.state.declaration.targets.filter(row => !['pages', 'github-actions'].includes(row.kind));
    f.state.declaration.fields = f.state.declaration.fields.filter(row => !['pages', 'automation'].includes(row.path[0]));
    f.state.manifestOverride.secrets = ['CLOUDFLARE_API_TOKEN'];
    const ns = await f.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'), account = 'a'.repeat(32);
    const lock = ns.get(ns.idFromName('deployment-account/v1/' + account)), blocker = 'dc-' + randomUUID().replaceAll('-', '');
    await lock.claim(f.auth.ownerId, blocker, account, 'other/repo/testing', [], 'd'.repeat(64));
    const plan = await f.preview(); assert.equal((await f.submit(plan)).status, 409); assert.equal(f.state.created.length, 0);
    await lock.release(blocker);
    f.f.bindings.SBA_CONNECTED_LINUX_EXECUTOR = JSON.stringify({ workflowId: 100, executorSha: '9'.repeat(40) });
    await f.f.restart(); assert.equal((await f.api('resume-plan', { taskId: plan.taskId })).status, 409);
    assert.equal(f.state.dispatches, 0); assert.equal(f.state.created.length, 0);
    f.f.bindings.SBA_CONNECTED_LINUX_EXECUTOR = pin; f.f.bindings.SBA_CONNECTED_EXECUTOR_SHA = '8'.repeat(40);
    await f.f.restart();
    const confirmation = await f.api('resume-plan', { taskId: plan.taskId }); assert.equal(confirmation.status, 200, confirmation.text);
    const { instance, ...body } = confirmation.json(); assert.equal(instance.application.id, plan.plan.application.manifest.id);
    assert.equal((await f.api('resume-submit', body)).status, 200);
    assert.equal(f.state.request.taskId, plan.taskId); assert.equal(f.state.executorSha, linuxSha);
    assert.equal(f.state.dispatches, 1); assert.equal(f.state.created.length, 1);
    assert.equal((await f.api('resume-submit', body)).status, 409); assert.equal(f.state.dispatches, 1);
  } finally { await f.f.close(); }
});

test('Linux repair keeps the parent runtime and only releases explicitly scoped secrets', async () => {
  const f = await linuxFixture(pin, { ENABLE_SERVICE_REPAIR: 'yes' });
  try {
    const first = await f.preview(); await f.submit(first);
    f.complete(await (await f.machine()).json(), 'unknown', { errorCode: 'APP_PUBLISH_UNKNOWN' });
    assert.equal((await f.api('reconcile', { taskId: first.taskId })).json().job.status, 'unknown');
    Object.assign(f.state.manifestOverride, { actions: { ...f.state.manifestOverride.actions, repair: { timeoutSeconds: 60 } },
      repairs: [{ id: 'publish-only', name: 'Synthetic publish repair', fromErrorCodes: ['APP_PUBLISH_UNKNOWN'], secretNames: ['CLOUDFLARE_API_TOKEN'] }] });
    const body = { action: 'repair', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, repairId: 'publish-only' };
    f.state.manifestOverride.runtime = WINDOWS_RUNTIME;
    assert.equal((await f.service('plan', body)).status, 409); assert.equal(f.state.dispatches, 1);
    f.state.manifestOverride.runtime = LINUX_RUNTIME;
    const response = await f.service('plan', body); assert.equal(response.status, 200, response.text);
    assert.equal(response.json().plan.policy.github.workflowId, 100); assert.equal((await f.submit(response.json())).status, 200);
    const permission = await (await f.machine()).json(); assert.equal(f.state.request.action, 'repair');
    assert.equal(permission.secrets.DEPLOY_GITHUB_TOKEN, 'repair-not-applicable');
    f.receipt(permission, 'succeeded', { checks: ['repair-completed', 'data-preserved', 'unchanged-resources-verified', 'service-ready'].map(id => ({ id, passed: true })) });
    assert.equal((await f.api('reconcile', { taskId: f.state.request.taskId })).json().job.status, 'succeeded');
    assert.equal((await f.api('state', { taskId: first.taskId })).json().job.status, 'unknown');
  } finally { await f.f.close(); }
});
