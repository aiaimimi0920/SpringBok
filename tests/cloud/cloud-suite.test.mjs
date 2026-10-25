import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suiteFixture } from './suite-fixture.mjs';
import { updatedSha } from './service-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
import { importComponents } from '../../cloud/service-import.mjs';

test('suite targets bind verified source credentials, survive restart and grant only one permit', async () => {
  const f = await suiteFixture();
  try {
    const plan = await f.preview();
    assert.equal(plan.plan.configuration.automation.repository, 'owner/repo');
    assert.equal(plan.plan.credentials.DEPLOY_GITHUB_TOKEN, 'github');
    assert.equal(f.state.created.length, 0);
    assert.equal((await f.submit(plan)).status, 200);
    assert.equal(f.state.created.length, 1); assert.equal(f.state.dispatches, 1);
    assert.equal(f.state.request.configuration.pages.name, 'testing-pages');
    await f.f.restart();
    assert.equal((await f.submit(plan)).status, 200); assert.equal(f.state.dispatches, 1);
    const permit = await (await f.machine()).json();
    assert.deepEqual(permit.secrets, { CLOUDFLARE_API_TOKEN: fakeToken, DEPLOY_GITHUB_TOKEN: fakeToken });
    assert.ok(!JSON.stringify(plan).includes(fakeToken));
    assert.ok(!JSON.stringify(permit).includes('synthetic-executor'));
    assert.equal((await f.machine()).status, 403);
    f.complete(permit);
    const state = (await f.service('service-state', { instanceId: plan.taskId, reconcile: true })).json();
    assert.equal(state.canDelete, false); assert.equal(state.canUpdate, true);
    assert.ok(state.instance.targets.some(t => t.kind === 'github-actions' && t.accountId === 'github:owner/repo'));
    assert.throws(() => importComponents(plan.plan.application));
  } finally { await f.f.close(); }
});

test('GitHub repository claims are global across Cloudflare accounts and fence before provisioning', async () => {
  const f = await suiteFixture();
  try {
    const ns = await f.f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'), scope = 'github:owner/repo';
    const lock = ns.get(ns.idFromName('deployment-account/v1/' + scope));
    await lock.claim('1'.repeat(64), 'dc-' + randomUUID().replaceAll('-', ''), scope, 'other/service/env', [], 'd'.repeat(64));
    const plan = await f.preview();
    assert.equal((await f.submit(plan)).status, 409);
    assert.equal(f.state.created.length, 0); assert.equal(f.state.dispatches, 0);
    await f.f.restart();
    assert.equal((await f.submit(plan)).status, 200);
    assert.equal(f.state.created.length, 0); assert.equal(f.state.dispatches, 0);
  } finally { await f.f.close(); }
});

test('suite previews isolate Pages and workflow environments; updates retain original identities', async () => {
  const f = await suiteFixture();
  try {
    const first = await f.preview(); await f.submit(first); f.complete(await (await f.machine()).json());
    await f.service('service-state', { instanceId: first.taskId, reconcile: true });
    const response = await f.service('plan', { action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId,
      sourceSha: updatedSha, environment: 'test-123456789abc' });
    assert.equal(response.status, 200, response.text); const plan = response.json();
    await f.submit(plan);
    const context = f.state.request.context;
    assert.equal(context.resources.find(r => r.kind === 'pages').remoteId, 'test-123456789abc-pages');
    assert.equal(context.resources.find(r => r.kind === 'github-actions').remoteId, '.github/workflows/refresh.yml@test-123456789abc');
    assert.ok(context.source.resources.some(r => r.kind === 'github-actions' && r.accountId === 'github:owner/repo'));
    f.complete(await (await f.machine()).json());
    await f.service('service-state', { instanceId: plan.taskId, reconcile: true });
    const cleanup = await f.service('plan', { action: 'destroy-preview', instanceId: plan.taskId, previousTaskId: plan.taskId });
    assert.equal(cleanup.status, 200, cleanup.text);
    await f.submit(cleanup.json());
    assert.ok(f.state.request.context.resources.every(r => !context.source.resources.some(s => s.accountId === r.accountId && s.kind === r.kind && s.remoteId === r.remoteId)));
    f.complete(await (await f.machine()).json());
    await f.service('service-state', { instanceId: plan.taskId, reconcile: true });
    const update = await f.service('plan', { ...f.input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } });
    assert.equal(update.status, 200, update.text);
    assert.equal((await f.submit(update.json())).status, 200);
    assert.equal(f.state.request.configuration.pages.name, 'testing-pages');
    assert.equal(f.state.request.configuration.automation.workflow, '.github/workflows/refresh.yml@testing');
  } finally { await f.f.close(); }
});

test('workflow environment and repository cannot be supplied through ordinary public inputs', async () => {
  const f = await suiteFixture();
  try {
    for (const values of [{ 'automation.repository': 'foreign/repo' }, { 'automation.workflow': '.github/workflows/refresh.yml@production' },
      { 'automation.workflow': '../refresh.yml@testing' }]) {
      assert.equal((await f.api('plan', { ...f.input, values })).status, 409);
    }
    assert.equal(f.state.created.length, 0); assert.equal(f.state.dispatches, 0);
  } finally { await f.f.close(); }
});
