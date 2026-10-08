import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture, updatedSha } from './service-fixture.mjs';
import { sourceSha } from './sba-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
const instanceBody = instanceId => ({ instanceId, reconcile: true });

test('service discovery reads all repository pages without derived connections or deployment writes; versions stay pinned', async () => {
  const { f, github, service, session, state, input } = await serviceFixture();
  try {
    const before = (await f.call('/api/admin/connections', session)).json();
    const first = (await service('catalog', { github, cursor: '' })).json(); assert.equal(first.items.length, 4); assert.equal(first.next, null);
    const application = (await service('application', { github, repository: 'owner/repo', sourceSha: null })).json();
    assert.equal(application.status, 'ready'); assert.equal(application.sourceSha, sourceSha);
    const versions = (await service('versions', { github, repository: 'owner/repo', cursor: '' })).json(); assert.equal(versions.items[1].sourceSha, updatedSha);
    state.headSha = updatedSha;
    assert.equal((await service('application', { github, repository: 'owner/repo', sourceSha })).json().manifest.version, '1.0.0');
    const draft = await service('plan', { ...input, github, repository: 'owner/repo' }); assert.equal(draft.status, 200, draft.text);
    state.repositoryPages = [Array.from({ length: 20 }, (_, i) => ({ id: i + 1, full_name: 'owner/repo' + i })), [{ id: 21, full_name: 'owner/repo' }]];
    assert.equal((await service('catalog', { github, cursor: '' })).json().next, '2'); assert.equal((await service('catalog', { github, cursor: '2' })).json().items[0].repository, 'owner/repo');
    assert.deepEqual((await f.call('/api/admin/connections', session)).json(), before);
    assert.equal((await service('services')).json().services.length, 0); assert.equal(state.dispatches, 0);
    assert.ok(!draft.text.includes(fakeToken));
  } finally { await f.close(); }
});
test('missing directory, unsupported declaration, fixed repository restrictions, revision and browser authorization fail closed', async () => {
  const { f, github, service, input, session } = await serviceFixture();
  try {
    assert.equal((await service('application', { github, repository: 'owner/empty', sourceSha: null })).json().status, 'absent');
    assert.equal((await service('application', { github, repository: 'owner/broken', sourceSha: null })).json().status, 'invalid');
    for (const body of [{ github: input.github, repository: 'owner/second', sourceSha: null }, { github: { ...github, revision: 2 }, repository: 'owner/repo', sourceSha: null }, { github, repository: '../bad', sourceSha: null }]) assert.equal((await service('application', body)).status, 409);
    assert.equal((await f.call('/api/admin/deployments/catalog', { ...session, headers: {}, body: { github, cursor: '' } })).status, 403);
    const other = f.jwt({ sub: 'another-owner' }), auth = (await f.call('/api/admin/state', { token: other })).json();
    assert.equal((await f.call('/api/admin/deployments/catalog', { token: other, headers: { 'x-csrf-token': auth.csrf }, body: { github, cursor: '' } })).status, 409);
  } finally { await f.close(); }
});
test('directory preflight skips deep reads only for absent trees and still validates pinned candidates', async () => {
  const { f, github, service, state } = await serviceFixture();
  try {
    const before = state.requests.length;
    const absent = await service('application', { github, repository: 'owner/empty', sourceSha: null, defaultBranch: 'main' });
    assert.equal(absent.status, 200); assert.equal(absent.json().status, 'absent');
    assert.deepEqual(state.requests.slice(before).filter(row => new URL(row.url).origin === 'https://api.github.com').map(row => row.url), ['https://api.github.com/repos/owner/empty/git/trees/main']);
    const ready = await service('application', { github, repository: 'owner/repo', sourceSha: null, defaultBranch: 'main' });
    assert.equal(ready.json().status, 'ready'); assert.equal(ready.json().sourceSha, sourceSha);
    assert.equal((await service('application', { github, repository: 'owner/broken', sourceSha: null, defaultBranch: 'main' })).json().status, 'invalid');
    for (const patch of [{ defaultBranch: '../main' }, { sourceSha }]) assert.equal((await service('application', { github, repository: 'owner/repo', sourceSha: null, defaultBranch: 'main', ...patch })).status, 409);
    const prior = state.provider; state.provider = (request, context) => request.url.endsWith('/git/trees/main') ? new Response(null, {status:403}) : prior(request,context);
    assert.equal((await service('application', { github, repository: 'owner/empty', sourceSha: null, defaultBranch: 'main' })).status, 409, 'denied tree is not a missing directory');
    assert.equal(state.dispatches,0);
  } finally { await f.close(); }
});
test('same instance updates using SBA update, original configuration/resources and exact receipt; restart retains both versions', async () => {
  const { f, github, service, input, state, submit, machine, receipt, api } = await serviceFixture();
  try {
    const first = (await service('plan', { ...input, github, repository: 'owner/repo' })).json(); await submit(first);
    receipt(await (await machine()).json(), 'deployed-unverified');
    const deployed = (await service('service-state', instanceBody(first.taskId))).json(); assert.equal(deployed.canUpdate, true); assert.equal(deployed.job.status, 'deployed-unverified');
    const before = structuredClone(state.request.configuration);
    const body = { ...input, github, repository: 'owner/repo', sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } };
    const response = await service('plan', body); assert.equal(response.status, 200, response.text); const next = response.json();
    assert.equal(next.plan.operation.action, 'update');
    const outcomes = await Promise.all([submit(next), submit(next)]); assert.ok(outcomes.every(r => r.status === 200), JSON.stringify(outcomes)); assert.equal(state.dispatches, 2);
    assert.equal(state.request.action, 'update'); assert.equal(state.request.sourceSha, updatedSha); assert.deepEqual(state.request.previous, { sourceSha, applicationVersion: '1.0.0' }); assert.deepEqual(state.request.configuration, before);
    assert.equal((await service('plan', body)).status, 409, 'old parent cannot create a competing update');
    const permit = await (await machine()).json(); assert.equal((await machine()).status, 403);
    await f.restart(); receipt(permit);
    const complete = (await service('service-state', instanceBody(first.taskId))).json(); assert.equal(complete.instance.id, first.taskId); assert.equal(complete.history.length, 2); assert.equal(complete.job.status, 'succeeded'); assert.equal(complete.job.request.applicationVersion, '2.0.0');
    assert.equal((await api('state', { taskId: first.taskId })).json().job.request.applicationVersion, '1.0.0');
    assert.equal((await service('services')).json().services.length, 1);
    assert.equal((await submit(next)).status, 200); assert.equal(state.dispatches, 2);
    const ns = await f.mf.getDurableObjectNamespace('CONNECTED_TASKS'), job = await ns.get(ns.idFromName('connected/v1/' + next.taskId)).inspect((await f.call('/api/admin/state')).json().ownerId);
    assert.equal(job.resultDeadline - job.permitAt, 720000, 'update timeout is used rather than deploy timeout');
  } finally { await f.close(); }
});
test('update rejects downgrade, same version, changed target/resources/configuration and preserves original claims', async () => {
  const { f, github, service, input, submit, machine, receipt, state } = await serviceFixture();
  try {
    const first = (await service('plan', { ...input, github, repository: 'owner/repo' })).json(); await submit(first); receipt(await (await machine()).json()); await service('service-state', instanceBody(first.taskId));
    const body = { ...input, github, repository: 'owner/repo', sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } };
    for (const version of ['1.0.0', '0.9.0']) { state.updateVersion = version; assert.equal((await service('plan', body)).status, 409); } state.updateVersion = '2.0.0';
    for (const patch of [{ environment: 'changed' }, { values: { ...body.values, 'server.name': 'changed' } }, { values: { ...body.values, vars: { changed: true } } }, { repository: 'owner/second' }]) assert.equal((await service('plan', { ...body, ...patch })).status, 409);
    state.updateDeclaration = { resources: [] }; assert.equal((await service('plan', { ...body, resources: {} })).status, 409); state.updateDeclaration = null;
    const initialAgain = (await service('plan', { ...input, github, repository: 'owner/repo' })).json(); assert.equal((await submit(initialAgain)).status, 409);
    assert.equal(state.dispatches, 1);
  } finally { await f.close(); }
});
test('failed or unknown updates retain the prior version and never allow another update or release target authority', async () => {
  for (const terminal of ['failed', 'unknown']) {
    const { f, github, service, input, submit, machine, receipt, state } = await serviceFixture();
    try {
      const first = (await service('plan', { ...input, github, repository: 'owner/repo' })).json(); await submit(first); receipt(await (await machine()).json()); await service('service-state', instanceBody(first.taskId));
      const body = { ...input, github, repository: 'owner/repo', sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } };
      const next = (await service('plan', body)).json(); await submit(next); receipt(await (await machine()).json(), terminal);
      const result = (await service('service-state', instanceBody(first.taskId))).json(); assert.equal(result.job.status, terminal); assert.equal(result.canUpdate, false); assert.equal(result.instance.previous.applicationVersion, '1.0.0');
      assert.equal((await service('plan', { ...body, instance: { id: first.taskId, previousTaskId: next.taskId } })).status, 409);
      await f.restart(); assert.equal((await service('service-state', instanceBody(first.taskId))).json().job.status, terminal); assert.equal(state.dispatches, 2);
      const locks = await f.mf.getDurableObjectNamespace('DEPLOYMENT_LOCKS'); await assert.rejects(locks.get(locks.idFromName('deployment-account/v1/' + 'a'.repeat(32))).claim('f'.repeat(64), 'dc-' + randomUUID().replaceAll('-', ''), 'a'.repeat(32), 'other/repo/test', [], 'e'.repeat(64)));
    } finally { await f.close(); }
  }
});
test('old index records remain readable and updatable; competing update confirmations cannot fork one instance', async () => {
  const { f, service, input, submit, machine, receipt, auth, state } = await serviceFixture();
  try {
    const first = (await service('plan', input)).json(); await submit(first); receipt(await (await machine()).json()); await service('service-state', instanceBody(first.taskId));
    const ns = await f.mf.getDurableObjectNamespace('CONNECTIONS'), vault = ns.get(ns.idFromName('connections/v1/' + auth.ownerId));
    await vault.legacyDeploymentIndex(); await f.restart();
    const old = (await service('service-state', instanceBody(first.taskId))).json(); assert.equal(old.instance.id, first.taskId); assert.equal(old.job.status, 'succeeded');
    const body = { ...input, sourceSha: updatedSha, instance: { id: first.taskId, previousTaskId: first.taskId } };
    const left = (await service('plan', body)).json(), right = (await service('plan', body)).json();
    const results = await Promise.all([submit(left), submit(right)]); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(state.dispatches, 2); assert.equal((await service('services')).json().services.length, 1);
    const loser = results[0].status === 409 ? left : right; assert.equal((await service('state', { taskId: loser.taskId })).status, 409);
  } finally { await f.close(); }
});
test('service pages and modules stay behind Access, root changes to services and history is retained without a navigation entry', async () => {
  const { f } = await serviceFixture();
  try {
    for (const path of ['/', '/services', '/history', '/services.js', '/services.css', '/service-model.mjs']) {
      assert.equal((await f.call(path, { token: null })).status, 403);
      const page = await f.call(path); assert.equal(page.status, 200, path); assert.equal(page.headers.get('cache-control'), 'no-store');
    }
    const page = (await f.call('/')).text; assert.match(page, /<h1>服务<\/h1>/); assert.doesNotMatch(page, /历史部署|deploy-sha/);
    assert.match((await f.call('/history')).text, /id="sba-panel"/);
  } finally { await f.close(); }
});
