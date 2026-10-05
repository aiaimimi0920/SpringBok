import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminFixture, origin } from './admin-fixture.mjs';
import { joinChallengeDigest } from '../../cloud/enrollment-contract.mjs';
import { openEnrollmentClient } from '../../src/node-enrollment/client.mjs';

const flags = { ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' };
const fixtureOptions = { entryPoint: 'tests/cloud/enrollment-fixture.mjs' };
async function auth(f, claims) { const token = f.jwt(claims), state = (await f.call('/api/admin/state', { token })).json(); return { token, ownerId: state.ownerId, headers: { 'x-csrf-token': state.csrf } }; }
async function server(f, access) {
  const revision = (await f.call('/api/admin/servers', access)).json().revision;
  const response = await f.call('/api/admin/servers', { ...access, body: { id: randomUUID(), revision, action: 'create', name: '加入测试服务器' } });
  assert.equal(response.status, 200); return response.json().server;
}
async function material(f, access, target) {
  const grant = { protocolVersion: 2, origin, ownerId: access.ownerId, nodeId: target.id, enrollmentId: randomUUID(), challenge: randomBytes(32).toString('hex') };
  return { grant, input: { id: grant.enrollmentId, revision: (await f.call('/api/admin/servers', access)).json().revision, serverId: target.id, challengeDigest: await joinChallengeDigest({ ownerId: grant.ownerId, nodeId: grant.nodeId }, grant.enrollmentId, grant.challenge) } };
}
async function prepare(f, access, input, expected = 200) { const r = await f.call('/api/admin/enrollments', { ...access, body: input }); assert.equal(r.status, expected, r.text); return r.json(); }
async function rpc(f, resource, context, operation, args = [], expected = 200) {
  const r = await f.call('/__enrollment_fixture', { body: { resource, context, operation, args } }); assert.equal(r.status, expected, `${operation}: ${r.text}`); return r.status === 200 ? r.json() : null;
}
const joinBody = enrollmentId => ({ protocolVersion: 2, enrollmentId, requestId: randomUUID(), executeDigest: randomBytes(32).toString('hex'), observeDigest: randomBytes(32).toString('hex') });
async function joinNode(f, grant, input, extra = {}, expected = 200) {
  const r = await f.call(`/node/v2/join/${grant.ownerId}/${grant.nodeId}`, { token: null, headers: { authorization: `Bearer ${grant.challenge}`, ...extra }, body: input }); assert.equal(r.status, expected, r.text); return r.json();
}

test('enrollment is default-off, owner/CSRF protected and never accepts self-reported authorization or legacy credentials', async () => {
  const disabled = await adminFixture();
  try {
    assert.equal((await disabled.call('/api/admin/state')).json().enrollmentEnabled, false);
    assert.equal((await disabled.call('/api/admin/enrollments', { body: {} })).status, 503);
    assert.equal((await disabled.call(`/node/v2/join/${'a'.repeat(64)}/${randomUUID()}`, { token: null, body: {} })).status, 503);
  } finally { await disabled.close(); }
  const f = await adminFixture(flags);
  try {
    const access = await auth(f), target = await server(f, access), { grant, input } = await material(f, access, target);
    for (const path of ['/enrollment.js', '/api/admin/enrollments', `/api/admin/enrollments/${target.id}`]) assert.equal((await f.call(path, { token: null })).status, 403);
    assert.equal((await f.call('/api/admin/enrollments', { token: access.token, body: input })).status, 403);
    await prepare(f, { ...access, headers: { ...access.headers, origin: 'https://other.invalid' } }, input, 403);
    for (const extra of [{ ownerId: access.ownerId }, { challenge: grant.challenge }, { operation: 'deploy' }, { revision: 99 }]) await prepare(f, access, { ...input, ...extra }, 409);
    const other = await auth(f, { sub: 'other-owner' }); await prepare(f, other, { ...input, revision: 0 }, 409);
    await joinNode(f, grant, joinBody(grant.enrollmentId), { authorization: `Bearer ${f.bindings.NODE_TOKEN}` }, 409);
    assert.equal((await f.call(`/api/admin/enrollments/${target.id}`, access)).json().enrollment, null);
    assert.equal((await f.call('/api/admin/state', access)).json().jobs.length, 0);
  } finally { await f.close(); }
});

test('actual UI-authorized metadata and independent node join are one-time, scope-bound and restart durable', async () => {
  const f = await adminFixture(flags, fixtureOptions);
  try {
    const access = await auth(f), a = await server(f, access), b = await server(f, access);
    const revision = (await f.call('/api/admin/servers', access)).json().revision;
    assert.equal((await f.call('/api/admin/services', { ...access, body: { id: randomUUID(), revision, action: 'create', serverId: a.id, name: '保留引用' } })).status, 200);
    const { grant, input } = await material(f, access, a), context = { ownerId: access.ownerId, nodeId: a.id };
    const oldCatalog = await rpc(f, 'catalog', context, 'inspect');
    const probe = { requestId: randomUUID(), revision: 0, challenge: randomBytes(32).toString('hex') };
    await rpc(f, 'node', context, 'submitProbe', [context, probe]);
    const oldNode = await rpc(f, 'node', context, 'snapshot', [context]);
    await prepare(f, access, input); await prepare(f, access, input);
    const current = (await f.call('/api/admin/servers', access)).json(); assert.equal(current.servers.find(row => row.id === a.id).state, 'enrolling');
    assert.equal((await f.call('/api/admin/services', access)).json().services.length, 1);
    for (const action of ['rename', 'archive']) assert.equal((await f.call('/api/admin/servers', { ...access, body: { id: randomUUID(), revision: current.revision, action, serverId: a.id, ...(action === 'rename' ? { name: '不能改名' } : {}) } })).status, 409);
    const upgraded = await rpc(f, 'catalog', context, 'inspect');
    const oldRequests = oldCatalog.find(table => table.name === 'catalog_requests').rows;
    const requests = upgraded.find(table => table.name === 'catalog_requests').rows;
    for (const row of oldRequests) assert.deepEqual(requests.find(next => next.request_id === row.request_id), row);
    assert.deepEqual(await rpc(f, 'node', context, 'snapshot', [context]), oldNode);
    await rpc(f, 'catalog', context, 'legacySnapshot', [access.ownerId], 409);
    await rpc(f, 'node', context, 'legacySnapshot', [context], 409);
    const body = joinBody(grant.enrollmentId);
    await joinNode(f, grant, body, { cookie: 'fake=1' }, 403);
    await joinNode(f, grant, body, { origin: 'https://other.invalid' }, 403);
    await joinNode(f, { ...grant, nodeId: b.id }, body, {}, 409);
    await joinNode(f, grant, { ...body, executeDigest: body.observeDigest }, {}, 409);
    await joinNode(f, grant, { ...body, ownerId: access.ownerId }, {}, 409);
    const replies = await Promise.all(Array.from({ length: 8 }, () => joinNode(f, grant, body)));
    assert.ok(replies.every(row => row.status === 'joined' && row.directoryState === 'active' && row.executionReady === false));
    await joinNode(f, grant, { ...body, requestId: randomUUID() }, {}, 409);
    await joinNode(f, grant, { ...body, observeDigest: randomBytes(32).toString('hex') }, {}, 409);
    const saved = (await f.call('/api/admin/servers', access)).json(); await f.restart();
    assert.deepEqual((await f.call('/api/admin/servers', access)).json(), saved);
    assert.deepEqual(await joinNode(f, grant, body), replies[0]);
    assert.equal((await f.call('/api/admin/enrollments/reconcile', { ...access, body: { serverId: a.id, enrollmentId: grant.enrollmentId } })).status, 200);
    const cloud = JSON.stringify([await rpc(f, 'catalog', context, 'inspect'), await rpc(f, 'node', context, 'inspect')]);
    assert.equal(cloud.includes(grant.challenge), false); assert.equal(cloud.includes(access.token), false);
    const bMaterial = await material(f, access, b); await prepare(f, access, bMaterial.input);
    const first = joinBody(bMaterial.grant.enrollmentId), second = joinBody(bMaterial.grant.enrollmentId);
    const competing = await Promise.all([first, second].map(body => f.call(`/node/v2/join/${access.ownerId}/${b.id}`, { token: null, headers: { authorization: `Bearer ${bMaterial.grant.challenge}` }, body })));
    assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  } finally { await f.close(); }
});

test('every cross-DO interruption and lost acknowledgement recovers only the original enrollment and persisted node secrets', async () => {
  for (const stage of ['catalog-prepare-after', 'node-prepare-before', 'node-prepare-after', 'node-join-after', 'catalog-finalize-before', 'catalog-finalize-after', 'lost-response']) {
    const f = await adminFixture({ ...flags, ENROLLMENT_FAULT: stage }, fixtureOptions), dir = mkdtempSync(join(tmpdir(), 'springbok-private-join-')); let client;
    try {
      const access = await auth(f), target = await server(f, access), { grant, input } = await material(f, access, target);
      await prepare(f, access, input, stage === 'catalog-prepare-after' ? 409 : stage.startsWith('node-prepare-') ? 202 : 200);
      const beforeRead = (await f.call('/api/admin/servers', access)).json();
      const status = await f.call(`/api/admin/enrollments/${target.id}`, access); assert.equal(status.status, 200);
      assert.deepEqual((await f.call('/api/admin/servers', access)).json(), beforeRead, 'GET must not repair or mutate');
      await f.restart();
      assert.equal((await f.call('/api/admin/enrollments/reconcile', { ...access, body: { serverId: target.id, enrollmentId: grant.enrollmentId } })).status, 200);
      let drop = stage === 'lost-response', sent;
      client = openEnrollmentClient({ directory: join(dir, 'node'), grant, fetcher: async (url, init) => {
        sent = JSON.parse(init.body); const response = await f.mf.dispatchFetch(url, init);
        if (drop) { drop = false; await response.body.cancel(); throw new Error('lost ack'); } return response;
      } });
      if (['node-join-after', 'lost-response'].includes(stage)) await assert.rejects(client.step());
      else await client.step();
      const prior = client.snapshot(), stored = JSON.parse(readFileSync(join(dir, 'node/ledger.json'), 'utf8')).events[0];
      assert.equal(statSync(join(dir, 'node/ledger.json')).mode & 0o077, 0);
      client.close(); client = null; await f.restart();
      client = openEnrollmentClient({ directory: join(dir, 'node'), grant, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
      const result = await client.step(); assert.equal(result.directoryState, 'active');
      assert.equal(result.requestId, prior.requestId); assert.equal(result.executeDigest, prior.executeDigest); assert.equal(result.observeDigest, prior.observeDigest);
      assert.notEqual(sent.executeDigest, sent.observeDigest);
      const context = { ownerId: access.ownerId, nodeId: target.id }, cloud = JSON.stringify(await rpc(f, 'node', context, 'inspect'));
      assert.equal(cloud.includes(stored.executeToken), false); assert.equal(cloud.includes(stored.observeToken), false);
      assert.equal((await f.call(`/api/admin/enrollments/${target.id}`, access)).json().node.status, 'joined');
    } finally { client?.close(); await f.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('expired capability and corrupt/missing/future enrollment storage fail closed without clearing evidence', async () => {
  const f = await adminFixture(flags, fixtureOptions);
  try {
    const access = await auth(f);
    for (const [resource, kind] of [['node', 'expire'], ['node', 'table'], ['node', 'version'], ['node', 'record'], ['catalog', 'table'], ['catalog', 'version'], ['catalog', 'record']]) {
      // 每种损坏使用独立 owner，防止损坏目录遮蔽其他测试。
      const own = await auth(f, { sub: randomUUID() }), target = await server(f, own), { grant, input } = await material(f, own, target);
      await prepare(f, own, input); const context = { ownerId: own.ownerId, nodeId: target.id };
      await rpc(f, resource, context, 'damage', [kind]); const damaged = await rpc(f, resource, context, 'inspect'); await f.restart();
      const response = await f.call(`/api/admin/enrollments/${target.id}`, own);
      assert.equal(response.status, resource === 'node' && kind === 'expire' ? 200 : 409);
      if (kind === 'expire') { assert.equal(response.json().node.status, 'expired'); await joinNode(f, grant, joinBody(grant.enrollmentId), {}, 409); }
      assert.deepEqual(await rpc(f, resource, context, 'inspect'), damaged);
    }
    const target = await server(f, access), { input } = await material(f, access, target), context = { ownerId: access.ownerId, nodeId: target.id };
    await rpc(f, 'catalog', context, 'damage', ['receipt']); const before = await rpc(f, 'catalog', context, 'inspect');
    await prepare(f, access, input, 409); assert.deepEqual(await rpc(f, 'catalog', context, 'inspect'), before, 'invalid v2 receipt must not migrate');
  } finally { await f.close(); }
});

test('pending enrollments reserve final receipts against all writers, across restart and at full capacity', async () => {
  const f = await adminFixture({ ...flags, ENROLLMENT_FAULT: 'catalog-finalize-before' }, fixtureOptions);
  try {
    const access = await auth(f), a = await server(f, access), b = await server(f, access), context = { ownerId: access.ownerId, nodeId: a.id };
    assert.equal(await rpc(f, 'catalog', context, 'fillToRevision', [access.ownerId, b.id, 1022]), 1022);
    const first = await material(f, access, a); await prepare(f, access, first.input);
    const revision = (await f.call('/api/admin/servers', access)).json().revision; assert.equal(revision, 1023);
    const second = await material(f, access, b); await prepare(f, access, second.input, 409);
    for (const [path, change] of [['servers', { action: 'rename', serverId: b.id, name: '抢占预留' }], ['services', { action: 'create', serverId: b.id, name: '抢占预留' }]]) {
      assert.equal((await f.call(`/api/admin/${path}`, { ...access, body: { id: randomUUID(), revision, ...change } })).status, 409);
    }
    const body = joinBody(first.grant.enrollmentId), joined = await joinNode(f, first.grant, body, {}, 202);
    assert.equal(joined.reconciliationRequired, true); await f.restart();
    const current = (await f.call(`/api/admin/enrollments/${a.id}`, access)).json();
    assert.equal(current.enrollment.state, 'enrolling'); assert.equal(current.node.status, 'joined');
    assert.equal((await f.call('/api/admin/enrollments/reconcile', { ...access, body: { serverId: a.id, enrollmentId: first.grant.enrollmentId } })).status, 200);
    const full = (await f.call('/api/admin/servers', access)).json(); assert.equal(full.revision, 1024); assert.equal(full.servers.find(row => row.id === a.id).state, 'active');
    await prepare(f, access, first.input); assert.equal((await joinNode(f, first.grant, body)).directoryState, 'active');
    await prepare(f, access, { ...second.input, revision: 1024 }, 409);
    assert.equal((await f.call('/api/admin/servers', { ...access, body: { id: randomUUID(), revision: 1024, action: 'create', name: '已满' } })).status, 409);
    assert.deepEqual((await f.call('/api/admin/servers', access)).json(), full);
    // 多个 pending 各持有一个独立预留槽，不能被第三次 prepare 或普通写入抢走。
    const own = await auth(f, { sub: 'multiple-pending' }), x = await server(f, own), y = await server(f, own), z = await server(f, own), scoped = { ownerId: own.ownerId, nodeId: x.id };
    await rpc(f, 'catalog', scoped, 'fillToRevision', [own.ownerId, z.id, 1020]);
    const mx = await material(f, own, x); await prepare(f, own, mx.input);
    const my = await material(f, own, y); await prepare(f, own, my.input);
    const mz = await material(f, own, z); await prepare(f, own, mz.input, 409);
    assert.equal((await f.call('/api/admin/servers', { ...own, body: { id: randomUUID(), revision: 1022, action: 'rename', serverId: z.id, name: '抢占两条预留' } })).status, 409);
    await joinNode(f, mx.grant, joinBody(mx.grant.enrollmentId), {}, 202);
    assert.equal((await f.call('/api/admin/enrollments/reconcile', { ...own, body: { serverId: x.id, enrollmentId: mx.grant.enrollmentId } })).status, 200);
    await joinNode(f, my.grant, joinBody(my.grant.enrollmentId));
    assert.equal((await f.call('/api/admin/servers', own)).json().revision, 1024);
  } finally { await f.close(); }
});
