import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adminFixture, issuer } from './admin-fixture.mjs';
import { sbaFixture } from './sba-fixture.mjs';
const clientId = `${'c'.repeat(32)}.access`;
const ownerActor = createHash('sha256').update(JSON.stringify([issuer, 'owner-subject'])).digest('hex');
const approval = () => ({ clientId, ownerActor, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 });
const bindings = a => ({ SBA_AUTOMATION_ACCESS: JSON.stringify(a), SBA_AUTOMATION_PROOF_KEY: 'd'.repeat(64) });
const claims = extra => ({ sub: '', email: undefined, common_name: clientId, ...extra });

test('service access defaults closed, strictly validates signed shape and never accepts raw client headers', async t => {
  const f = await adminFixture(); t.after(() => f.close());
  assert.equal((await f.call('/api/admin/sba/state', { token: f.jwt(claims()) })).status, 403);
  assert.equal((await f.call('/api/admin/sba/state', { token: null, headers: { 'cf-access-client-id': clientId, 'cf-access-client-secret': 'synthetic' } })).status, 403);
  const g = await adminFixture(bindings(approval())); t.after(() => g.close());
  for (const change of [{ common_name: `${'e'.repeat(32)}.access` }, { common_name: undefined }, { email: '' }, { email: null },
    { email: 'owner@example.invalid' }, { sub: undefined }, { sub: 'foreign', email: undefined }, { type: 'service' },
    { iss: 'https://foreign.cloudflareaccess.com' }, { aud: ['f'.repeat(64)] }, { exp: Math.floor(Date.now() / 1000) - 60 }])
    assert.equal((await g.call('/api/admin/sba/state', { token: g.jwt(claims(change)) })).status, 403);
  const token = g.jwt(claims());
  assert.equal((await g.call('/api/admin/sba/state', { token: token.slice(0, -10) + 'tampered!!' })).status, 403);
  // A real human remains the old identity path even when the automation configuration is present.
  assert.equal((await g.call('/api/admin/state')).status, 200);
  assert.equal((await g.call('/api/admin/state', { token: g.jwt({ email: 'other@example.invalid', common_name: clientId }) })).status, 403);
});

test('service delegation denies malformed or inactive approval and every route outside the exact SBA scope', async t => {
  const now = Date.now(), good = approval();
  for (const value of [{ ...good, expiresAt: now - 1 }, { ...good, issuedAt: now + 60000 }, { ...good, expiresAt: good.issuedAt + 86400001 },
    { ...good, ownerActor: 'raw-owner' }, { ...good, clientId: 'unbound' }, { ...good, extra: true }, { ...good, issuedAt: 0 }, []]) {
    const f = await adminFixture(bindings(value));
    try { assert.equal((await f.call('/api/admin/sba/state', { token: f.jwt(claims()) })).status, 403); }
    finally { await f.close(); }
  }
  const f = await adminFixture(bindings(good)); t.after(() => f.close());
  const token = f.jwt(claims());
  for (const path of ['/', '/sba.js', '/api/admin/state', '/api/admin/servers', '/api/admin/enrollments', '/api/admin/sba/new-route', '/api/admin/sba/state?key=value'])
    assert.equal((await f.call(path, { token })).status, 403, path);
  for (const headers of [{ cookie: 'CF_Authorization=synthetic' }, { origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }])
    assert.equal((await f.call('/api/admin/sba/state', { token, headers })).status, 403);
  assert.equal((await f.call('/api/admin/sba/state', { token, method: 'POST', body: {} })).status, 403);
  f.bindings.SBA_AUTOMATION_PROOF_KEY = ''; await f.restart();
  assert.equal((await f.call('/api/admin/sba/state', { token })).status, 403);
});

test('fresh service JWTs retain bounded proof, original owner and single submit; revocation rejects old proof', async t => {
  const a = approval(), x = await sbaFixture(t, bindings(a)), f = x.f;
  const first = f.jwt(claims()), session = (await f.call('/api/admin/sba/session', { token: first })).json();
  assert.equal(session.ownerId, x.adminState.ownerId);
  assert.deepEqual(session.authentication, { type: 'access-service-token', clientId, expiresAt: a.expiresAt });
  assert.doesNotMatch(JSON.stringify(session), /proofKey|synthetic-github|synthetic-deployment-secret/);
  const headers = { 'x-csrf-token': session.csrf };
  const post = (path, body, token = first) => f.call(`/api/admin/sba/${path}`, { token, body, headers });
  const preview = await post('preview', { taskId: 'service-test-task' }); assert.equal(preview.status, 200);
  const refreshed = f.jwt(claims({ iat: Math.floor(Date.now() / 1000) - 2 }));
  assert.notEqual(first, refreshed);
  const refreshedSession = (await f.call('/api/admin/sba/session', { token: refreshed })).json();
  assert.equal(refreshedSession.csrf, session.csrf);
  assert.equal((await f.call('/api/admin/sba/submit', { token: refreshed, body: preview.json() })).status, 409);
  assert.equal((await post('submit', preview.json(), refreshed)).status, 200);
  assert.equal((await post('submit', preview.json(), refreshed)).status, 200); assert.equal(x.state.dispatches, 1);
  const userState = (await f.call('/api/admin/sba/state', { token: x.session })).json();
  assert.deepEqual((await f.call('/api/admin/sba/state', { token: refreshed })).json(), userState);
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ ...a, ownerActor: 'e'.repeat(64) }); await f.restart();
  assert.equal((await f.call('/api/admin/sba/session', { token: refreshed })).status, 409); // The original task owner is not inferred from configuration.
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ ...a, expiresAt: Date.now() - 1 }); await f.restart();
  assert.equal((await post('submit', preview.json(), refreshed)).status, 403);
  f.bindings.SBA_AUTOMATION_ACCESS = ''; await f.restart();
  assert.equal((await f.call('/api/admin/sba/session', { token: refreshed })).status, 403);
  assert.deepEqual((await f.call('/api/admin/sba/state', { token: x.session })).json(), userState);
  assert.equal(x.state.dispatches, 1);
});
