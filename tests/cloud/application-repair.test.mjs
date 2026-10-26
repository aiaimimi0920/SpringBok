import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suiteFixture } from './suite-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';

const values = { APP_COOKIE_SECRET: 'synthetic-repair-cookie-only', APP_STORAGE_KEY: 'synthetic-repair-storage-only' };
async function fixture(secretNames = ['CLOUDFLARE_API_TOKEN', 'DEPLOY_GITHUB_TOKEN', 'APP_COOKIE_SECRET']) {
  const f = await suiteFixture({ ENABLE_SERVICE_REPAIR: 'yes' });
  f.state.declaration.applicationSecrets = Object.keys(values);
  f.state.manifestOverride.secrets.push(...Object.keys(values));
  const application = (await f.api('application', { github: f.input.github, repository: 'owner/repo', sourceSha: f.input.sourceSha })).json();
  const resource = body => f.f.call('/api/admin/resources', { ...f.session, body });
  const saved = await resource({ action: 'application-secrets', id: randomUUID(), repository: 'owner/repo', applicationId: application.manifest.id, values });
  assert.equal(saved.status, 200, saved.text);
  const { id, revision } = saved.json().profile;
  f.input.applicationSecrets = { id, revision };
  const first = await f.preview();
  assert.equal((await f.submit(first)).status, 200);
  f.receipt(await (await f.machine()).json(), 'unknown', { errorCode: 'APP_SETUP_UNKNOWN' });
  const original = (await f.api('reconcile', { taskId: first.taskId })).json();
  assert.equal(original.job.status, 'unknown');
  f.state.manifestOverride.actions.repair = { timeoutSeconds: 300 };
  f.state.manifestOverride.repairs = [{ id: 'setup-repair', name: 'Synthetic suite repair', fromErrorCodes: ['APP_SETUP_UNKNOWN'], secretNames }];
  const body = { action: 'repair', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, repairId: 'setup-repair' };
  const ns = await f.f.mf.getDurableObjectNamespace('CONNECTIONS');
  const vault = ns.get(ns.idFromName('connections/v1/' + f.auth.ownerId));
  return { ...f, first, original, body, resource, vault };
}

test('suite repair inherits the exact profile, snapshots only declared secrets, and preserves unknown history across restart', async () => {
  const f = await fixture();
  try {
    const response = await f.service('plan', f.body);
    assert.equal(response.status, 200, response.text);
    const plan = response.json();
    assert.deepEqual(plan.plan.applicationSecrets, f.input.applicationSecrets);
    assert.equal(plan.plan.credentials.APP_COOKIE_SECRET, 'application:APP_COOKIE_SECRET');
    assert.equal(plan.plan.credentials.APP_STORAGE_KEY, 'repair-disabled');
    assert.ok(!JSON.stringify(plan).includes(values.APP_COOKIE_SECRET));
    const replies = await Promise.all([f.submit(plan), f.submit(plan)]);
    assert.ok(replies.every(row => row.status === 200), JSON.stringify(replies));
    assert.equal(f.state.dispatches, 2);
    assert.equal(f.state.created.length, 1, 'repair does not recreate the platform database');
    const snapshot = await f.vault.inspectApplicationSecrets();
    assert.equal(snapshot.tasks.length, 3, 'two original snapshots and one scoped repair snapshot');
    assert.ok(!JSON.stringify(snapshot).includes(values.APP_COOKIE_SECRET));
    assert.equal((await f.resource({ action: 'disable-application-secrets', ...f.input.applicationSecrets })).status, 200);
    await f.f.restart();
    const permit = await (await f.machine()).json();
    assert.equal(permit.secrets.APP_COOKIE_SECRET, values.APP_COOKIE_SECRET);
    assert.equal(permit.secrets.APP_STORAGE_KEY, 'repair-not-applicable');
    assert.ok(!JSON.stringify(permit).includes(values.APP_STORAGE_KEY));
    assert.equal((await f.machine()).status, 403);
    f.receipt(permit, 'succeeded', { checks: ['repair-completed', 'data-preserved', 'unchanged-resources-verified', 'service-ready'].map(id => ({ id, passed: true })) });
    const ready = (await f.service('service-state', { instanceId: f.first.taskId, reconcile: true })).json();
    assert.equal(ready.job.status, 'succeeded');
    assert.equal(ready.history.length, 2);
    assert.deepEqual((await f.api('state', { taskId: f.first.taskId })).json().job, f.original.job);
  } finally { await f.f.close(); }
});

test('repair rejects profile replacement, undeclared new secrets and disabled profiles without dispatch or resource creation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service('plan', { ...f.body, applicationSecrets: f.input.applicationSecrets })).status, 409);
    f.state.manifestOverride.secrets.push('APP_OTHER_SECRET');
    f.state.manifestOverride.repairs[0].secretNames.push('APP_OTHER_SECRET');
    assert.equal((await f.service('plan', f.body)).status, 409);
    f.state.manifestOverride.secrets.pop();
    f.state.manifestOverride.repairs[0].secretNames.pop();
    assert.equal((await f.resource({ action: 'disable-application-secrets', ...f.input.applicationSecrets })).status, 200);
    assert.equal((await f.service('plan', f.body)).status, 409);
    assert.equal(f.state.dispatches, 1);
    assert.equal(f.state.created.length, 1);
  } finally { await f.f.close(); }
});

test('an empty repair secret scope grants no application or connection credentials and creates no secret snapshots', async () => {
  const f = await fixture([]);
  try {
    const response = await f.service('plan', f.body);
    assert.equal(response.status, 200, response.text);
    assert.equal((await f.submit(response.json())).status, 200);
    const permit = await (await f.machine()).json();
    assert.ok(Object.values(permit.secrets).every(value => value === 'repair-not-applicable'));
    assert.equal((await f.vault.inspectApplicationSecrets()).tasks.length, 2);
    assert.equal(f.state.dispatches, 2);
  } finally { await f.f.close(); }
});

test('disabling the original profile after planning rejects repair submission before dispatch or snapshot reservation', async () => {
  const f = await fixture();
  try {
    const response = await f.service('plan', f.body);
    assert.equal(response.status, 200, response.text);
    assert.equal((await f.resource({ action: 'disable-application-secrets', ...f.input.applicationSecrets })).status, 200);
    assert.equal((await f.submit(response.json())).status, 409);
    assert.equal(f.state.dispatches, 1);
    assert.equal(f.state.created.length, 1);
    assert.equal((await f.vault.inspectApplicationSecrets()).tasks.length, 2);
  } finally { await f.f.close(); }
});
