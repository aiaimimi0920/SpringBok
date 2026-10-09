import test from 'node:test';
import assert from 'node:assert/strict';
import { adminFixture, origin } from './admin-fixture.mjs';
test('Access login return can enter services and history without allowing cross-site APIs', async () => {
  const f = await adminFixture();
  try {
    const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (const path of ['/services', '/history']) {
      assert.equal((await f.call(path, { headers })).status, 200, path);
      assert.equal((await f.call(path, { headers, token: null })).status, 403);
      assert.equal((await f.call(path, { headers, token: f.jwt({ email: 'other@example.invalid' }) })).status, 403);
      assert.equal((await f.call(path, { headers: { ...headers, origin: 'https://other.invalid' } })).status, 403);
      assert.equal((await f.call(path + '?unexpected=1', { headers })).status, 403);
    }
    for (const path of ['/services.js', '/api/admin/state', '/api/admin/deployments']) assert.equal((await f.call(path, { headers })).status, 403, path);
    assert.equal((await f.call('/api/admin/submit', { headers, body: {} })).status, 403);
  } finally { await f.close(); }
});
test('actual workerd protects all static assets and admin APIs with verified Access identity', async () => {
  const f = await adminFixture();
  try {
    for (const path of ['/', '/app.js', '/style.css', '/tokens.css', '/shell.js', '/resource-tree.js', '/resource-model.mjs', '/resource-tree.css', '/api/admin/state']) assert.equal((await f.call(path, { token: null, headers: { 'cf-access-authenticated-user-email': 'owner@example.invalid' } })).status, 403);
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [{ email: 'other@example.invalid' }, { email: undefined }, { sub: undefined }, { iss: 'https://attacker.invalid' }, { aud: ['3'.repeat(64)] }, { exp: now - 60 }, { nbf: now + 120 }, { iat: now + 120 }, { type: 'service' }, { exp: now + 90000 }]) assert.equal((await f.call('/api/admin/state', { token: f.jwt(claims) })).status, 403);
    for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }]) assert.equal((await f.call('/api/admin/state', { token: f.jwt({}, header) })).status, 403);
    const jwt = f.jwt(); assert.equal((await f.call('/api/admin/state', { token: jwt.slice(0, -10) + 'tampered!!' })).status, 403);
    for (const path of ['/', '/app.js', '/style.css', '/tokens.css', '/shell.js', '/resource-tree.js', '/resource-model.mjs', '/resource-tree.css']) { const r = await f.call(path); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.ok(!r.text.includes(f.bindings.CONTROL_TOKEN) && !r.text.includes(f.bindings.NODE_TOKEN)); }
    assert.equal((await f.call('/control/state', { headers: { authorization: `Bearer ${f.bindings.CONTROL_TOKEN}` } })).status, 404);
    assert.equal((await f.call('/api/admin/state', { headers: { origin: 'https://other.invalid' } })).status, 403);
    assert.equal((await f.call('/api/admin/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await f.call('/api/admin/state', { token: f.jwt({}, { jku: 'https://attacker.invalid/keys' }) })).status, 200);
    assert.equal((await f.call('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status, 200);
    assert.ok(f.keyCalls <= 2);
  } finally { await f.close(); }
});
test('same-session/origin/content confirmation and durable actor audit prevent stale, duplicate or cross-role execution', async () => {
  const f = await adminFixture();
  try {
    const token = f.jwt(), state = (await f.call('/api/admin/state', { token })).json(), headers = { 'x-csrf-token': state.csrf };
    const request = { id: 'confirmed-cycle', revision: state.revision };
    assert.equal((await f.call('/api/admin/preview', { token, body: request })).status, 403);
    assert.equal((await f.call('/api/admin/preview', { token: f.jwt({ sub: 'other-session', iat: Math.floor(Date.now() / 1000) - 1 }), body: request, headers })).status, 403);
    assert.equal((await f.call('/api/admin/preview', { token, body: request, headers: { ...headers, origin: 'https://other.invalid' } })).status, 403);
    const before = (await f.call('/api/admin/state', { token })).json();
    const preview = (await f.call('/api/admin/preview', { token, body: request, headers })).json();
    assert.ok(preview.confirmation);
    const otherToken = f.jwt({ iat: Math.floor(Date.now() / 1000) - 2 });
    const otherCsrf = (await f.call('/api/admin/state', { token: otherToken })).json().csrf;
    assert.equal((await f.call('/api/admin/submit', { token: otherToken, body: preview, headers: { 'x-csrf-token': otherCsrf } })).status, 409);
    const stale = (await f.call('/api/admin/preview', { token, body: { id: 'stale-plan', revision: state.revision }, headers })).json();
    assert.deepEqual((await f.call('/api/admin/state', { token })).json(), before);
    for (const changed of [{ ...preview, input: { ...preview.input, id: 'tampered' } }, { ...preview, expiresAt: 0 }, { ...preview, actor: 'human' }]) assert.ok((await f.call('/api/admin/submit', { token, body: changed, headers })).status >= 400);
    const accepted = await f.call('/api/admin/submit', { token, body: preview, headers }); assert.equal(accepted.status, 200); assert.equal(accepted.json().status, 'queued');
    assert.equal((await f.call('/api/admin/submit', { token, body: stale, headers })).status, 403);
    assert.equal((await f.call('/api/admin/submit', { token, body: preview, headers })).status, 200);
    let current = (await f.call('/api/admin/state', { token })).json(); assert.equal(current.jobs.length, 1); assert.equal(current.audit.length, 1); assert.match(current.audit[0].actor, /^[a-f0-9]{64}$/); assert.equal(current.ready, false);
    assert.equal((await f.call('/api/admin/preview', { token, body: { id: 'different', revision: current.revision }, headers })).status, 403);
    await f.restart(); current = (await f.call('/api/admin/state', { token })).json(); assert.equal(current.audit.length, 1); assert.equal(current.jobs.length, 1);
    // Node does not receive the admin JWT or control token, and cannot use management APIs.
    const claim = await f.call('/node/poll', { token: null, body: { node: 'pc2-test' }, headers: { authorization: `Bearer ${f.bindings.NODE_TOKEN}` } }); assert.equal(claim.json().status, 'delivery');
    assert.equal((await f.call('/api/admin/state', { token: null, headers: { authorization: `Bearer ${f.bindings.NODE_TOKEN}` } })).status, 403);
    const outcome = await f.call('/node/report', { token: null, body: { id: preview.input.id, challenge: preview.input.challenge, outcome: 'unknown' }, headers: { authorization: `Bearer ${f.bindings.NODE_TOKEN}` } }); assert.equal(outcome.json().status, 'unknown');
    assert.equal((await f.call('/api/admin/state', { token })).json().ready, false);
  } finally { await f.close(); }
});
test('empty administrator configuration, untrusted issuer and key-fetch failure fail closed', async () => {
  for (const overrides of [{ ADMIN_EMAILS: '[]' }, { ADMIN_EMAILS: '["owner@example.invalid","other@example.invalid"]' }, { ACCESS_ISSUER: 'https://attacker.invalid' }, { ACCESS_AUD: '' }]) {
    const f = await adminFixture(overrides); try { assert.equal((await f.call('/')).status, 403); assert.equal(f.keyCalls, 0); } finally { await f.close(); }
  }
  const f = await adminFixture(); try { f.outage = true; assert.equal((await f.call('/')).status, 403); } finally { await f.close(); }
});
