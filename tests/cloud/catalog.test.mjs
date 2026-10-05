import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminFixture } from './admin-fixture.mjs';
import { MAX_SERVERS, MAX_CATALOG_REQUESTS } from '../../cloud/catalog-contract.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

const path = '/api/admin/servers';
const create = (revision, name = '测试服务器') => ({ id: randomUUID(), revision, action: 'create', name });
async function session(f, claims) {
  const token = f.jwt(claims), response = await f.call('/api/admin/state', { token });
  assert.equal(response.status, 200);
  return { token, headers: { 'x-csrf-token': response.json().csrf } };
}
async function snapshot(f, options) { const r = await f.call(path, options); assert.equal(r.status, 200); return r.json(); }
async function mutate(f, auth, body, status = 200) { const r = await f.call(path, { ...auth, body }); assert.equal(r.status, status, r.text); return r.json(); }

test('catalog defaults closed; protected module and API require Access, same origin and session CSRF', async () => {
  const disabled = await adminFixture();
  try {
    assert.equal((await disabled.call('/api/admin/state')).json().catalogEnabled, false);
    assert.equal((await disabled.call(path)).status, 503);
    assert.equal((await disabled.call(path, { body: create(0) })).status, 503);
  } finally { await disabled.close(); }
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    for (const url of [path, '/catalog.js']) {
      assert.equal((await f.call(url, { token: null, headers: { 'cf-access-authenticated-user-email': 'owner@example.invalid' } })).status, 403);
      assert.equal((await f.call(url, { token: null, headers: { authorization: `Bearer ${f.bindings.NODE_TOKEN}` } })).status, 403);
      assert.equal((await f.call(url, { token: f.jwt({ type: 'service' }) })).status, 403);
    }
    const module = await f.call('/catalog.js'); assert.equal(module.status, 200); assert.equal(module.headers.get('cache-control'), 'no-store');
    const auth = await session(f), request = create(0);
    assert.equal((await f.call(path, { body: request })).status, 403);
    await mutate(f, { ...auth, headers: { ...auth.headers, origin: 'https://other.invalid' } }, request, 403);
    await mutate(f, { ...auth, token: f.jwt({ sub: 'other-owner' }) }, request, 403);
    await mutate(f, { ...auth, headers: { ...auth.headers, 'content-type': 'text/plain' } }, request, 409);
    for (const body of [{ ...request, owner: 'other' }, { ...request, serverId: randomUUID() }, { ...request, name: 'a'.repeat(65) }, { ...request, action: 'deploy' }]) await mutate(f, auth, body, 409);
    assert.equal((await f.call(path, { method: 'DELETE', ...auth })).status, 404);
    assert.equal((await snapshot(f)).revision, 0);
  } finally { await f.close(); }
});

test('SQLite catalog is owner-isolated, idempotent and restart durable without creating fixture jobs', async () => {
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    const auth = await session(f), before = (await f.call('/api/admin/state', auth)).json();
    assert.deepEqual(await snapshot(f), { mode: 'server-catalog-only', executionReady: false, revision: 0, servers: [] });
    const request = create(0, '  Cafe\u0301  '), first = await mutate(f, auth, request);
    assert.equal(first.revision, 1); assert.equal(first.server.name, 'Café'); assert.equal(first.server.state, 'draft');
    assert.notEqual(first.server.id, request.id);
    assert.deepEqual(await mutate(f, auth, { ...request, name: 'Café' }), first);
    await mutate(f, auth, { ...request, name: 'changed' }, 409);
    await mutate(f, auth, create(0), 409);
    const other = await session(f, { sub: 'other-owner' });
    assert.equal((await snapshot(f, other)).servers.length, 0);
    await mutate(f, other, { id: randomUUID(), revision: 0, action: 'rename', serverId: first.server.id, name: 'stolen' }, 409);
    const independent = await mutate(f, other, request); assert.notEqual(independent.server.id, first.server.id);
    const renamed = await mutate(f, auth, { id: randomUUID(), revision: 1, action: 'rename', serverId: first.server.id, name: '<b>本机</b>' });
    assert.equal(renamed.server.id, first.server.id); assert.equal(renamed.server.createdAt, first.server.createdAt);
    assert.ok(renamed.server.updatedAt >= first.server.updatedAt);
    const archive = { id: randomUUID(), revision: 2, action: 'archive', serverId: first.server.id };
    const archived = await mutate(f, auth, archive); assert.equal(archived.server.state, 'archived');
    await mutate(f, auth, { ...archive, id: randomUUID(), revision: 3 }, 409);
    await mutate(f, auth, { ...archive, id: randomUUID(), revision: 3, action: 'rename', name: 'revive' }, 409);
    const saved = await snapshot(f, auth); assert.equal(saved.revision, 3); assert.equal(saved.servers.length, 1);
    await f.restart();
    assert.deepEqual(await snapshot(f, auth), saved);
    assert.deepEqual(await mutate(f, auth, request), first); // Original receipt, not today's server state.
    assert.deepEqual(await mutate(f, auth, archive), archived);
    assert.equal((await snapshot(f, other)).servers[0].id, independent.server.id);
    assert.deepEqual((await f.call('/api/admin/state', auth)).json(), before);
  } finally { await f.close(); }
});

test('concurrent revisions serialize once and a repeated request replays the same result', async () => {
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    const auth = await session(f), same = create(0);
    const replay = await Promise.all([mutate(f, auth, same), mutate(f, auth, same)]);
    assert.deepEqual(replay[0], replay[1]);
    const contenders = await Promise.all([create(1, 'A'), create(1, 'B')].map(body => f.call(path, { ...auth, body })));
    assert.deepEqual(contenders.map(r => r.status).sort(), [200, 409]);
    const current = await snapshot(f); assert.equal(current.revision, 2); assert.equal(current.servers.length, 2);
  } finally { await f.close(); }
});

test('server and receipt caps reject new writes without pruning reads or idempotent receipts', async () => {
  const f = await adminFixture({ ENABLE_CATALOG: 'yes' });
  try {
    const auth = await session(f), request = create(0), first = await mutate(f, auth, request);
    for (let revision = 1; revision < MAX_SERVERS; revision++) await mutate(f, auth, create(revision));
    await mutate(f, auth, create(MAX_SERVERS), 409);
    await mutate(f, auth, { id: randomUUID(), revision: MAX_SERVERS, action: 'archive', serverId: first.server.id });
    await mutate(f, auth, create(MAX_SERVERS + 1), 409); // Archived rows still consume capacity.
    const second = (await snapshot(f)).servers.find(row => row.state === 'draft');
    for (let revision = MAX_SERVERS + 1; revision < MAX_CATALOG_REQUESTS; revision++) {
      await mutate(f, auth, { id: randomUUID(), revision, action: 'rename', serverId: second.id, name: `revision-${revision}` });
    }
    await mutate(f, auth, { id: randomUUID(), revision: MAX_CATALOG_REQUESTS, action: 'archive', serverId: second.id }, 409);
    assert.equal((await f.call('/api/admin/services', { ...auth, body: { id: randomUUID(), revision: MAX_CATALOG_REQUESTS, action: 'create', serverId: second.id, name: '上限后不能写入服务' } })).status, 409);
    const full = await snapshot(f); assert.equal(full.revision, MAX_CATALOG_REQUESTS); assert.equal(full.servers.length, MAX_SERVERS);
    await f.restart(); assert.deepEqual(await snapshot(f), full); assert.deepEqual(await mutate(f, auth, request), first);
  } finally { await f.close(); }
});

test('catalog toggle preserves data; future schema, missing tables, metadata and columns fail closed across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-catalog-schema-'));
  const bundle = (await build({ entryPoints: [fileURLToPath(new URL('./catalog-storage-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })).outputFiles[0].text;
  const options = { modules: true, script: bundle, compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0,
    durableObjects: { REGISTRY: { className: 'TestCatalog', useSQLite: true } }, resourcePersistencePath: join(directory, 'state'),
    telemetry: { enabled: false }, cf: false, bindings: { ENABLE_ADMIN: 'yes', ENABLE_CATALOG: 'yes' } };
  let mf;
  const restart = async () => { await mf?.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready; };
  // RPC 在 workerd 内 await，再以 JSON 穿过 Node 边界，不能把 Miniflare 的远程 RpcPromise 代理当成结果。
  const stub = async name => Object.fromEntries(['snapshot', 'mutate', 'serviceSnapshot', 'mutateService', 'legacy', 'legacySnapshot', 'damage', 'inspect'].map(operation => [operation, async (...args) => {
    const response = await mf.dispatchFetch(`https://catalog.invalid/${name}`, { method: 'POST', body: JSON.stringify({ operation, args }) });
    assert.equal(response.status, 200, `${name}/${operation}`); return response.json();
  }]));
  const owner = 'a'.repeat(64), request = create(0);
  try {
    await restart(); let catalog = await stub('migration');
    const legacyRequest = create(0), legacyReceipt = await catalog.legacy(owner, legacyRequest);
    const legacyArchive = { id: randomUUID(), revision: 1, action: 'archive', serverId: legacyReceipt.server.id };
    await catalog.legacy(owner, legacyArchive);
    const liveRequest = create(2), liveReceipt = await catalog.legacy(owner, liveRequest);
    const legacySaved = await catalog.legacySnapshot(owner), original = await catalog.inspect();
    assert.equal(original.metadata[0].schema_version, 1);
    await assert.rejects(catalog.snapshot('f'.repeat(64))); assert.deepEqual(await catalog.inspect(), original);
    assert.deepEqual(await catalog.snapshot(owner), legacySaved);
    const expanded = await catalog.inspect();
    assert.equal(expanded.metadata[0].schema_version, 2); assert.equal(expanded.metadata[0].revision, original.metadata[0].revision);
    assert.deepEqual(expanded.servers, original.servers); assert.deepEqual(expanded.requests, original.requests);
    assert.deepEqual(await catalog.mutate(owner, legacyRequest), legacyReceipt);
    const serviceRequest = { id: randomUUID(), revision: 3, action: 'create', serverId: liveReceipt.server.id, name: '迁移后服务' };
    const serviceReceipt = await catalog.mutateService(owner, serviceRequest);
    await assert.rejects(catalog.legacySnapshot(owner)); // 精确旧实现必须拒绝 v2，而不是绕过服务引用归档服务器。
    const upgraded = await catalog.inspect();
    await restart(); catalog = await stub('migration');
    assert.deepEqual(await catalog.inspect(), upgraded); assert.deepEqual(await catalog.mutateService(owner, serviceRequest), serviceReceipt);
    assert.deepEqual(await catalog.mutate(owner, legacyArchive), { id: legacyArchive.id, revision: 2, server: legacySaved.servers.find(row => row.id === legacyReceipt.server.id) });
    for (const kind of ['v1Row', 'v1Requests', 'receiptJson', 'receiptShape', 'receiptRevision']) {
      catalog = await stub(kind); await catalog.legacy(owner, create(0)); await catalog.damage(kind);
      const damaged = await catalog.inspect();
      await assert.rejects(catalog.snapshot(owner)); await assert.rejects(catalog.serviceSnapshot(owner));
      assert.deepEqual(await catalog.inspect(), damaged, 'invalid v1 must remain unchanged when migration fails');
    }
    for (const kind of ['receiptJson', 'receiptShape', 'receiptRevision']) {
      catalog = await stub(`v2-${kind}`); const server = (await catalog.mutate(owner, create(0))).server;
      const service = { id: randomUUID(), revision: 1, action: 'create', serverId: server.id, name: '服务回执' };
      await catalog.mutateService(owner, service); await catalog.damage(kind);
      const damaged = await catalog.inspect();
      await restart(); catalog = await stub(`v2-${kind}`);
      await assert.rejects(catalog.mutateService(owner, service));
      assert.deepEqual(await catalog.inspect(), damaged, 'invalid v2 service receipt cannot become a successful replay');
    }
    catalog = await stub('toggle');
    const receipt = await catalog.mutate(owner, request), saved = await catalog.snapshot(owner);
    await assert.rejects(catalog.snapshot('f'.repeat(64))); await assert.rejects(catalog.mutate('f'.repeat(64), request));
    assert.deepEqual(await catalog.snapshot(owner), saved);
    options.bindings.ENABLE_CATALOG = 'no'; await restart(); catalog = await stub('toggle');
    const disabled = await catalog.inspect();
    await assert.rejects(catalog.snapshot(owner)); await assert.rejects(catalog.mutate(owner, request));
    assert.deepEqual(await catalog.inspect(), disabled);
    options.bindings.ENABLE_CATALOG = 'yes'; await restart(); catalog = await stub('toggle');
    assert.deepEqual(await catalog.snapshot(owner), saved); assert.deepEqual(await catalog.mutate(owner, request), receipt);
    for (const kind of ['version', 'table', 'metadata', 'column', 'serviceTable', 'serviceColumn', 'serviceName', 'serviceTime', 'serviceReference', 'linkedArchive']) {
      catalog = await stub(kind); const created = await catalog.mutate(owner, request);
      // 有实际子行时 SQLite 外键会阻止 DROP 父表；缺父表注入使用空服务表，其余注入保留关联服务。
      if (kind !== 'table') await catalog.mutateService(owner, { id: randomUUID(), revision: 1, action: 'create', serverId: created.server.id, name: '保留服务' });
      await catalog.damage(kind);
      const damaged = await catalog.inspect();
      await restart(); catalog = await stub(kind);
      await assert.rejects(catalog.snapshot(owner)); await assert.rejects(catalog.mutate(owner, create(1)));
      await assert.rejects(catalog.serviceSnapshot(owner));
      await assert.rejects(catalog.mutateService(owner, { id: randomUUID(), revision: 2, action: 'create', serverId: created.server.id, name: '不能修复' }));
      assert.deepEqual(await catalog.inspect(), damaged, `${kind} must not be silently reset or repaired`);
    }
  } finally { await mf?.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
