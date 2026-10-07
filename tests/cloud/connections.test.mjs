import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionsFixture, fakeToken } from './connections-fixture.mjs';
const path = '/api/admin/connections';
const input = () => ({ action: 'create', id: randomUUID(), name: '生产连接', provider: 'cloudflare', target: 'a'.repeat(32), token: fakeToken });
async function auth(f, claims) { const token = f.jwt(claims), r = await f.call('/api/admin/state', { token }); return { token, headers: { 'x-csrf-token': r.json().csrf }, owner: r.json().ownerId }; }
async function post(f, session, body, status = 200) { const r = await f.call(path, { ...session, body }); assert.equal(r.status, status, r.text); assert.ok(!r.text.includes(fakeToken)); return r.json(); }

test('connections defaults closed and settings/API require Access, same origin, CSRF and bounded exact input', async () => {
  const { f, state } = await connectionsFixture({ ENABLE_CONNECTIONS: 'no' });
  try {
    assert.equal((await f.call(path)).status, 503);
    f.bindings.ENABLE_CONNECTIONS = 'yes'; await f.restart(); const session = await auth(f);
    for (const route of [path, '/settings', '/connections.js']) assert.equal((await f.call(route, { token: null })).status, 403);
    assert.equal((await f.call('/settings')).status, 200);
    assert.equal((await f.call('/settings', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
    assert.equal((await f.call(path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    await post(f, {}, input(), 403);
    await post(f, { ...session, headers: { ...session.headers, origin: 'https://evil.invalid' } }, input(), 403);
    await post(f, session, { ...input(), owner: session.owner }, 409);
    await post(f, session, { ...input(), token: 'x'.repeat(3000) }, 409);
    assert.equal(state.requests.length, 0);
    assert.equal((await f.call(path, { method: 'DELETE', ...session })).status, 404);
    f.bindings.CONNECTIONS_ENCRYPTION_KEY = ''; await f.restart(); assert.equal((await f.call(path)).status, 503);
  } finally { await f.close(); }
});

test('service identities never acquire settings or credential access', async () => {
  const { f } = await connectionsFixture();
  try {
    const session = await auth(f), clientId = 'b'.repeat(32) + '.access', now = Date.now();
    f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ clientId, ownerActor: session.owner, issuedAt: now - 1000, expiresAt: now + 60000 });
    f.bindings.SBA_AUTOMATION_PROOF_KEY = 'c'.repeat(64); await f.restart();
    const token = f.jwt({ sub: '', email: undefined, common_name: clientId });
    for (const route of [path, '/settings', '/connections.js']) assert.equal((await f.call(route, { token })).status, 403);
    await post(f, { token, headers: session.headers }, input(), 403);
  } finally { await f.close(); }
});

test('in-flight verification cannot reenable a disabled connection', async () => {
  const { f, state } = await connectionsFixture(); let release;
  try {
    const session = await auth(f), request = input(); await post(f, session, request);
    state.hold = new Promise(resolve => { release = resolve; });
    let started; const observed = new Promise(resolve => { started = resolve; }); state.onRequest = started;
    const verifying = f.call(path, { ...session, body: { action: 'verify', id: request.id, revision: 1 } });
    await observed;
    await post(f, session, { action: 'disable', id: request.id, revision: 1 });
    release(); assert.equal((await verifying).status, 409);
    assert.equal((await f.call(path, session)).json().connections[0].state, 'disabled');
  } finally { release?.(); await f.close(); }
});

test('capacity counts disabled connections and concurrent last-slot creation commits only one', async () => {
  const { f } = await connectionsFixture();
  try {
    const session = await auth(f); let first;
    for (let i = 0; i < 31; i++) { const row = await post(f, session, input()); first ??= row.connection; }
    await post(f, session, { action: 'disable', id: first.id, revision: 1 });
    const results = await Promise.all([input(), input()].map(body => f.call(path, { ...session, body })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    await post(f, session, input(), 409); assert.equal((await f.call(path, session)).json().connections.length, 32);
  } finally { await f.close(); }
});

test('partial SQLite loss never silently reconstructs an existing vault', async () => {
  for (const kind of ['owner', 'table']) {
    const { f } = await connectionsFixture();
    try {
      const session = await auth(f); await post(f, session, input());
      const ns = await f.mf.getDurableObjectNamespace('CONNECTIONS'), stub = ns.get(ns.idFromName(`connections/v1/${session.owner}`));
      await stub.breakStorage(kind); assert.equal((await f.call(path, session)).status, 409);
      await post(f, session, input(), 409);
    } finally { await f.close(); }
  }
});

test('encrypted SQLite connections persist, never expose tokens, isolate owners and deduplicate creation', async () => {
  const { f, state } = await connectionsFixture();
  try {
    const session = await auth(f), request = input();
    const first = await post(f, session, request); assert.equal(first.connection.state, 'verified');
    assert.equal(first.connection.deploymentPermissionsVerified, false);
    assert.deepEqual(await post(f, session, request), first); assert.equal(state.requests.length, 1);
    await post(f, session, { ...request, token: fakeToken + 'other' }, 409);
    const ns = await f.mf.getDurableObjectNamespace('CONNECTIONS'); const stub = ns.get(ns.idFromName(`connections/v1/${session.owner}`));
    const raw = await stub.inspectStorage(); assert.equal(raw.length, 1); assert.ok(!JSON.stringify(raw).includes(fakeToken)); assert.ok(raw[0].sealed.includes('cipher'));
    const other = await auth(f, { sub: 'other-owner' });
    assert.equal((await f.call(path, other)).json().connections.length, 0);
    await post(f, other, { action: 'disable', id: request.id, revision: 1 }, 409);
    await assert.rejects(stub.snapshot(other.owner));
    await f.restart(); assert.deepEqual((await f.call(path, session)).json().connections, [first.connection]);
    assert.equal((await f.call('/api/admin/state', session)).json().jobs.length, 0);
  } finally { await f.close(); }
});

test('GitHub read scope, failed recheck, revision conflicts and terminal disable preserve deployment isolation', async () => {
  const { f, state } = await connectionsFixture();
  try {
    const session = await auth(f), request = { ...input(), provider: 'github', target: 'owner/repo' };
    const first = await post(f, session, request); assert.equal(first.connection.check, 'repository-actions-read');
    assert.equal(state.requests.length, 3); assert.ok(state.requests.every(r => r.method === 'GET'));
    state.reject = true;
    const failed = await post(f, session, { action: 'verify', id: request.id, revision: 1 });
    assert.equal(failed.connection.state, 'failed'); assert.equal(failed.connection.revision, 2);
    await post(f, session, { action: 'disable', id: request.id, revision: 1 }, 409);
    const disabled = await post(f, session, { action: 'disable', id: request.id, revision: 2 }); assert.equal(disabled.connection.state, 'disabled');
    const count = state.requests.length;
    await post(f, session, { action: 'verify', id: request.id, revision: 3 }, 409); assert.equal(state.requests.length, count);
    await post(f, session, input(), 422); assert.equal((await f.call(path, session)).json().connections.length, 1);
  } finally { await f.close(); }
});

test('concurrent creates commit one connection and changed encryption key fails recheck closed', async () => {
  const { f } = await connectionsFixture();
  try {
    const session = await auth(f), request = input();
    const result = await Promise.all([post(f, session, request), post(f, session, request)]); assert.deepEqual(result[0], result[1]);
    assert.equal((await f.call(path, session)).json().connections.length, 1);
    f.bindings.CONNECTIONS_ENCRYPTION_KEY = '8'.repeat(64); await f.restart();
    const failed = await post(f, session, { action: 'verify', id: request.id, revision: 1 }); assert.equal(failed.connection.check, 'credential-unavailable');
    assert.equal(failed.connection.state, 'failed');
  } finally { await f.close(); }
});
