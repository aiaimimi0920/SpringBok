import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminFixture } from './admin-fixture.mjs';
import { MAX_SERVICES } from '../../cloud/catalog-contract.mjs';

const servers = '/api/admin/servers', services = '/api/admin/services';
const createServer = (revision, name = '服务器') => ({ id: randomUUID(), revision, action: 'create', name });
const createService = (revision, serverId, name = '服务') => ({ id: randomUUID(), revision, action: 'create', serverId, name });
async function auth(f, claims) {
  const token = f.jwt(claims), session = await f.call('/api/admin/state', { token });
  assert.equal(session.status, 200);
  return { token, headers: { 'x-csrf-token': session.json().csrf } };
}
async function write(f, path, session, body, status = 200) {
  const response = await f.call(path, { ...session, body });
  assert.equal(response.status, status, response.text); return response.json();
}
async function read(f, path, session) {
  const response = await f.call(path, session); assert.equal(response.status, 200); return response.json();
}

test('service routes preserve default-off, Access, origin, CSRF and exact metadata-only input boundaries', async () => {
  const disabled = await adminFixture();
  try { assert.equal((await disabled.call(services)).status, 503); assert.equal((await disabled.call(services, { body: createService(0, randomUUID()) })).status, 503); }
  finally { await disabled.close(); }
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    const session = await auth(f), request = createService(0, randomUUID());
    for (const token of [null, f.jwt({ type: 'service' }), f.jwt({ email: 'denied@example.invalid' })]) assert.equal((await f.call(services, { token })).status, 403);
    await write(f, services, {}, request, 403);
    await write(f, services, { ...session, token: f.jwt({ sub: 'other' }) }, request, 403);
    await write(f, services, { ...session, headers: { ...session.headers, origin: 'https://other.invalid' } }, request, 403);
    await write(f, services, { ...session, headers: { ...session.headers, 'content-type': 'text/plain' } }, request, 409);
    for (const body of [{ ...request, owner: 'other' }, { ...request, state: 'ready' }, { ...request, command: 'deploy' }, { ...request, name: 'x'.repeat(65) }]) await write(f, services, session, body, 409);
    assert.equal((await f.call(services, { ...session, method: 'DELETE' })).status, 404);
    assert.deepEqual(await read(f, services, session), { mode: 'service-catalog-only', executionReady: false, revision: 0, services: [] });
  } finally { await f.close(); }
});

test('owner-scoped services require live references, persist metadata and original receipts, and block linked server archive', async () => {
  const f = await adminFixture({ ENABLE_CATALOG: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' });
  try {
    const session = await auth(f), other = await auth(f, { sub: 'other' });
    const before = (await f.call('/api/admin/state', session)).json();
    const server = (await write(f, servers, session, createServer(0))).server;
    const request = createService(1, server.id, '  Cafe\u0301  ');
    await write(f, services, other, { ...request, revision: 0 }, 409);
    await write(f, services, session, { ...request, serverId: randomUUID() }, 409);
    const first = await write(f, services, session, request);
    assert.equal(first.revision, 2); assert.equal(first.service.name, 'Café'); assert.equal(first.service.serverId, server.id);
    assert.equal(first.service.state, 'draft'); assert.notEqual(first.service.id, request.id);
    assert.deepEqual(await write(f, services, session, { ...request, name: 'Café' }), first);
    await write(f, services, session, { ...request, name: 'changed' }, 409);
    // 请求 ID 在所有资源中共享，不能把服务回执当服务器回执，或反过来。
    await write(f, servers, session, { id: request.id, revision: 1, action: 'create', name: 'Café' }, 409);
    await write(f, services, other, { id: randomUUID(), revision: 0, action: 'rename', serviceId: first.service.id, name: 'stolen' }, 409);
    assert.equal((await read(f, services, other)).services.length, 0);
    const archiveServer = { id: randomUUID(), revision: 2, action: 'archive', serverId: server.id };
    await write(f, servers, session, archiveServer, 409);
    const rename = { id: randomUUID(), revision: 2, action: 'rename', serviceId: first.service.id, name: '<b>新服务</b>' };
    const renamed = await write(f, services, session, rename);
    assert.equal(renamed.service.createdAt, first.service.createdAt); assert.ok(renamed.service.updatedAt >= first.service.updatedAt);
    await write(f, services, session, { ...rename, id: randomUUID(), revision: 3, serverId: randomUUID() }, 409);
    const archive = { id: randomUUID(), revision: 3, action: 'archive', serviceId: first.service.id };
    const archived = await write(f, services, session, archive);
    await write(f, servers, session, { ...archiveServer, revision: 4 });
    await write(f, services, session, createService(5, server.id), 409);
    await write(f, services, session, { ...rename, id: randomUUID(), revision: 5 }, 409);
    await write(f, services, session, { ...archive, id: randomUUID(), revision: 5 }, 409);
    const saved = await read(f, services, session), savedServers = await read(f, servers, session);
    await f.restart(); assert.deepEqual(await read(f, services, session), saved); assert.deepEqual(await read(f, servers, session), savedServers);
    assert.deepEqual(await write(f, services, session, request), first);
    assert.deepEqual(await write(f, services, session, archive), archived);
    assert.deepEqual((await f.call('/api/admin/state', session)).json(), before);
  } finally { await f.close(); }
});

test('service create and server archive share atomic revision and reference constraints', async () => {
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    const session = await auth(f), serverRequest = createServer(0), server = (await write(f, servers, session, serverRequest)).server;
    await write(f, services, session, { ...createService(0, server.id), id: serverRequest.id }, 409);
    const same = createService(1, server.id);
    const receipts = await Promise.all([write(f, services, session, same), write(f, services, session, same)]);
    assert.deepEqual(receipts[0], receipts[1]);
    const second = (await write(f, servers, session, createServer(2))).server;
    const responses = await Promise.all([
      f.call(services, { ...session, body: createService(3, second.id) }),
      f.call(servers, { ...session, body: { id: randomUUID(), revision: 3, action: 'archive', serverId: second.id } }),
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const current = await read(f, services, session), serverState = await read(f, servers, session);
    assert.equal(current.revision, 4); assert.equal(serverState.revision, 4);
    for (const service of current.services) assert.equal(serverState.servers.find(row => row.id === service.serverId).state, 'draft');
  } finally { await f.close(); }
});

test('service capacity counts archived records and preserves reads and old receipts across restart', async () => {
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    const session = await auth(f), server = (await write(f, servers, session, createServer(0))).server;
    const request = createService(1, server.id), first = await write(f, services, session, request);
    for (let revision = 2; revision <= MAX_SERVICES; revision++) await write(f, services, session, createService(revision, server.id));
    await write(f, services, session, createService(MAX_SERVICES + 1, server.id), 409);
    await write(f, services, session, { id: randomUUID(), revision: MAX_SERVICES + 1, action: 'archive', serviceId: first.service.id });
    await write(f, services, session, createService(MAX_SERVICES + 2, server.id), 409);
    const full = await read(f, services, session); assert.equal(full.services.length, MAX_SERVICES);
    await f.restart(); assert.deepEqual(await read(f, services, session), full); assert.deepEqual(await write(f, services, session, request), first);
  } finally { await f.close(); }
});
