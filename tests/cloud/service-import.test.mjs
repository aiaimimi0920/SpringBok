import test from 'node:test';
import assert from 'node:assert/strict';
import { importFixture } from './service-import-fixture.mjs';
import { sbaDigest, sbaRequest, sbaObjectName } from '../../cloud/sba-control.mjs';
import { manifest, policy, sourceSha, sha } from './sba-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';

const object = async (f, binding, name) => { const ns = await f.mf.getDurableObjectNamespace(binding); return ns.get(ns.idFromName(name)); };
const preview = async x => { const r = await x.service('import-preview', x.draft); assert.equal(r.status, 200, r.text); return r.json(); };

test('import reads only provider metadata, preserves unknown version, commits once and survives restart', async t => {
  const x = await importFixture(); t.after(() => x.f.close()); const { f, state, service, session } = x;
  const before = (await f.call('/api/admin/connections', session)).json(); state.requests.length = 0;
  const p = await preview(x);
  assert.equal(p.candidate.instance.application.version, null); assert.equal(p.candidate.instance.application.sourceSha, null);
  assert.equal(p.candidate.instance.application.definitionSha, sourceSha);
  assert.equal(p.candidate.instance.resources.resource0.name, 'test-database');
  assert.equal(p.candidate.components[0].domains[0], 'https://test.example.invalid');
  assert.doesNotMatch(JSON.stringify(p), /never-return-this|synthetic-connection-token/);
  assert.equal((await service('services')).json().services.length, 0);
  const result = await service('import-submit', p); assert.equal(result.status, 200, result.text);
  const record = result.json(); assert.equal(record.status, 'imported'); assert.equal(record.canUpdate, false); assert.equal(record.job, null);
  assert.deepEqual((await service('import-submit', p)).json(), record);
  const again = await preview(x); assert.deepEqual((await service('import-submit', again)).json(), record);
  await f.restart();
  assert.deepEqual((await service('service-state', { instanceId: record.instance.id, reconcile: true })).json(), { ...record, canDelete: true });
  assert.equal((await service('services')).json().services.length, 1);
  assert.deepEqual((await f.call('/api/admin/connections', session)).json(), before);
  assert.equal(state.dispatches, 0); assert.ok(state.requests.every(row => row.method === 'GET'));
  assert.ok(state.requests.every(row => ['api.github.com', 'api.cloudflare.com'].includes(new URL(row.url).hostname)));
});

test('import rejects CSRF, foreign owners, malformed inputs, stale connections and confirmation drift', async t => {
  const x = await importFixture(); t.after(() => x.f.close()); const { f, service, state, draft, session } = x;
  const p = await preview(x);
  for (const body of [{ ...draft, owner: 'f'.repeat(64) }, { ...draft, sourceSha: 'main' }, { ...draft, components: { 'server.name': '../secret' } },
    { ...draft, components: {} }, { ...draft, cloudflare: { ...draft.cloudflare, revision: 2 } }]) assert.equal((await service('import-preview', body)).status, 409);
  assert.equal((await f.call('/api/admin/deployments/import-submit', { token: session.token, body: p })).status, 403);
  assert.equal((await f.call('/api/admin/deployments/import-submit', { ...session, headers: { ...session.headers, origin: 'https://foreign.invalid' }, body: p })).status, 403);
  const token = f.jwt({ sub: 'foreign-owner' }), other = (await f.call('/api/admin/state', { token })).json();
  assert.equal((await f.call('/api/admin/deployments/import-submit', { token, body: p, headers: { 'x-csrf-token': other.csrf } })).status, 409);
  for (const change of [{ expiresAt: 1 }, { confirmation: 'invalid' }, { candidate: { ...p.candidate, digest: '1'.repeat(64) } }]) assert.equal((await service('import-submit', { ...p, ...change })).status, 409);
  state.importDomains.push({ service: 'test-worker', hostname: 'changed.example.invalid' });
  assert.equal((await service('import-submit', p)).status, 409);
  assert.equal((await service('services')).json().services.length, 0);
  assert.equal((await f.call('/service-import.js', { token: null })).status, 403);
});

test('binding order is stable, resource metadata and permissions are required, no partial import is saved', async t => {
  const x = await importFixture(); t.after(() => x.f.close()); const { state, service } = x;
  state.importBindings.push({ name: 'KV', type: 'kv_namespace', namespace_id: '1'.repeat(32) }, { name: 'BUCKET', type: 'r2_bucket', bucket_name: 'test-bucket', jurisdiction: 'eu' });
  const p = await preview(x); state.importBindings.reverse();
  assert.equal((await preview(x)).candidate.digest, p.candidate.digest);
  for (const path of ['/workers/scripts/test-worker/settings', '/workers/domains', '/d1/database/' + x.resource.remoteId, '/storage/kv/namespaces', '/r2/buckets/test-bucket']) {
    state.importDenied = path; const r = await service('import-submit', p); assert.equal(r.status, 409, path); assert.doesNotMatch(r.text, /never-return/);
  }
  state.importDenied = null; state.importBindings = [];
  assert.equal((await service('import-preview', x.draft)).status, 409);
  assert.equal((await service('services')).json().services.length, 0);
});

test('account-wide import claims survive interruption and block old/new deployment paths and foreign owners', async t => {
  const x = await importFixture(); t.after(() => x.f.close()); const { f, service, auth } = x;
  const p = await preview(x), c = p.candidate, account = c.instance.accountId;
  const locks = await object(f, 'DEPLOYMENT_LOCKS', 'deployment-account/v1/' + account);
  const keys = [...new Set([...Object.values(c.instance.resources).flatMap(row => [row.remoteId, row.name]), ...c.instance.targets.map(row => row.value)])].sort();
  const app = { id: c.instance.application.id, repository: c.instance.application.repository };
  // Simulate loss between the committed account claim and the owner index write.
  await locks.registerImported(auth.ownerId, c.id, account, keys, app);
  assert.equal((await service('services')).json().services.length, 0);
  await assert.rejects(locks.registerImported('f'.repeat(64), c.id, account, keys, app));
  await assert.rejects(locks.claim(auth.ownerId, 'dc-' + '8'.repeat(32), account, 'test', ['identity:test-worker'], 'a'.repeat(64)));
  await assert.rejects(locks.claim(auth.ownerId, 'dc-' + '9'.repeat(32), account, 'test', [], 'a'.repeat(64), [x.resource.remoteId]));
  await f.restart();
  assert.equal((await service('import-submit', p)).status, 200);
  assert.equal((await service('services')).json().services.length, 1);
  const other = { ...x.draft, components: { 'server.name': 'other-worker' } };
  const conflict = await service('import-preview', other); assert.equal(conflict.status, 200);
  assert.equal((await service('import-submit', conflict.json())).status, 409);
});

test('existing deployment keys cannot be stolen by imports', async t => {
  const x = await importFixture(); t.after(() => x.f.close());
  const p = await preview(x), locks = await object(x.f, 'DEPLOYMENT_LOCKS', 'deployment-account/v1/' + 'a'.repeat(32));
  await locks.claim(x.auth.ownerId, 'dc-' + '8'.repeat(32), 'a'.repeat(32), 'existing', ['identity:test-worker'], 'a'.repeat(64));
  assert.equal((await x.service('import-submit', p)).status, 409);
  assert.equal((await x.service('services')).json().services.length, 0);
});

test('fixed-task import needs bounded automation approval, preserves unknown provenance and original job', async t => {
  const x = await importFixture(); t.after(() => x.f.close()); const { f, auth, state } = x;
  const legacyPolicy = { ...policy, github: { ...policy.github, applicationRepository: 'owner/repo' }, configuration: { accountId: 'a'.repeat(32), server: { name: 'test-worker' }, vars: {}, database: { id: x.resource.remoteId, name: 'test-database' } } };
  const clientId = 'c'.repeat(32) + '.access', now = Date.now();
  Object.assign(f.bindings, { SBA_POLICY: JSON.stringify(legacyPolicy), SBA_APPLICATION_SECRETS: JSON.stringify({ CLOUDFLARE_API_TOKEN: fakeToken }),
    SBA_AUTOMATION_ACCESS: JSON.stringify({ clientId, ownerActor: auth.ownerId, issuedAt: now - 1000, expiresAt: now + 3600000 }), SBA_AUTOMATION_PROOF_KEY: 'd'.repeat(64) });
  await f.restart();
  const stub = await object(f, 'SBA_TASKS', sbaObjectName(legacyPolicy)), request = sbaRequest(legacyPolicy, 'legacy-import-task', manifest), requestDigest = await sbaDigest(request);
  await stub.begin(auth.ownerId, { request, manifest }); await stub.attachRun(auth.ownerId, request.taskId, { status: 'dispatched', runId: 456, requestDigest });
  const permit = await stub.permit(request.taskId, requestDigest, 456);
  await stub.settle(auth.ownerId, { schemaVersion: 1, runId: 456, runAttempt: 1, executorSha: sha, requestDigest, permitId: permit.permitId,
    result: { schemaVersion: 2, taskId: request.taskId, action: 'deploy', sourceSha, applicationVersion: '1.0.0', status: 'unknown', checks: [{ id: 'readiness', passed: false }], errorCode: 'TEST_READINESS_FAILED' } });
  const token = f.jwt({ sub: '', email: undefined, common_name: clientId });
  const a = (await f.call('/api/admin/sba/session', { token })).json(), session = { token, headers: { 'x-csrf-token': a.csrf } };
  const legacy = (mode, body) => f.call('/api/admin/sba/' + mode, { ...session, body });
  const before = (await f.call('/api/admin/sba/state', { token })).json(), job = before.job;
  const draft = { taskId: request.taskId, definitionSha: 'c'.repeat(40) }, approved = { ...draft, jobDigest: await sbaDigest({ request: job.request, status: job.status, runId: job.runId, result: job.result }), issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000 };
  assert.equal((await legacy('import-preview', draft)).status, 409);
  for (const approval of [{ ...approved, taskId: 'wrong-task' }, { ...approved, definitionSha: 'e'.repeat(40) }, { ...approved, jobDigest: 'e'.repeat(64) }, { ...approved, expiresAt: 1 }, { ...approved, expiresAt: now + 1000000 }, { ...approved, issuedAt: now + 100000 }]) {
    f.bindings.SBA_IMPORT_APPROVAL = JSON.stringify(approval); await f.restart(); assert.equal((await legacy('import-preview', draft)).status, 409);
  }
  f.bindings.SBA_IMPORT_APPROVAL = JSON.stringify(approved); await f.restart();
  const p = await legacy('import-preview', draft); assert.equal(p.status, 200, p.text);
  assert.equal((await f.call('/api/admin/deployments/import-preview', { ...session, body: x.draft })).status, 403);
  assert.equal((await f.call('/service-import.js', { token })).status, 403);
  const imported = await legacy('import-submit', p.json()); assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.json().provenance.status, 'unknown'); assert.equal(imported.json().provenance.result.errorCode, 'TEST_READINESS_FAILED');
  assert.equal(imported.json().instance.application.version, null);
  assert.equal(imported.json().definition.sourceSha, draft.definitionSha);
  assert.equal(imported.json().provenance.sourceSha, sourceSha);
  assert.deepEqual((await f.call('/api/admin/sba/state', { token })).json(), before);
  f.bindings.SBA_IMPORT_APPROVAL = ''; await f.restart(); assert.equal((await legacy('import-submit', p.json())).status, 409);
  assert.equal(state.dispatches, 0);
});
