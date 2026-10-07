import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionInput } from '../cloud/connections-contract.mjs';
import { sealToken, openToken } from '../cloud/connections-crypto.mjs';
import { verifyConnection } from '../cloud/connections-provider.mjs';
const token = 'synthetic-not-a-real-token-123456';
const input = () => ({ action: 'create', id: randomUUID(), name: '测试连接', provider: 'cloudflare', target: 'a'.repeat(32), token });

test('connection contract rejects extra owner, SSRF targets, headers, malformed IDs and unsupported providers', () => {
  const good = input(); assert.deepEqual(connectionInput(good), good);
  assert.equal(connectionInput({ ...good, name: '  Cafe\u0301 ' }).name, 'Café');
  for (const change of [{ owner: 'other' }, { target: 'https://evil.invalid' }, { token: token + '\r\nInjected: yes' },
    { id: '../secret' }, { name: '' }, { provider: 'r2' }, { token: '' }, { name: 'a'.repeat(65) }, { action: 'deploy' }]) assert.throws(() => connectionInput({ ...good, ...change }));
  assert.throws(() => connectionInput({ ...good, provider: 'github', target: 'owner/../secret' }));
  assert.equal(connectionInput({ ...good, provider: 'github', target: 'owner/repo' }).target, 'owner/repo');
});

test('AES-GCM uses randomized envelopes and binds owner, row identity, provider and target', async () => {
  const row = input(), key = '1'.repeat(64), owner = '2'.repeat(64);
  const a = await sealToken(key, owner, row, token), b = await sealToken(key, owner, row, token);
  assert.notEqual(a, b); assert.ok(!a.includes(token)); assert.equal(await openToken(key, owner, row, a), token);
  for (const [k, o, r] of [['3'.repeat(64), owner, row], [key, '4'.repeat(64), row], [key, owner, { ...row, id: randomUUID() }],
    [key, owner, { ...row, provider: 'github' }], [key, owner, { ...row, target: 'b'.repeat(32) }]]) await assert.rejects(openToken(k, o, r, a));
  await assert.rejects(openToken(key, owner, row, JSON.stringify({ ...JSON.parse(a), cipher: '00'.repeat(40) })));
  await assert.rejects(sealToken('invalid', owner, row, token));
});

test('provider checks only fixed official GETs, rejects redirects, errors, wrong identities and malformed bodies', async () => {
  const row = input(), seen = [];
  const transport = async (url, options) => { seen.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.authorization, `Bearer ${token}`); return Response.json({ success: true, result: { id: row.target } }); };
  assert.deepEqual(await verifyConnection(row, token, transport), { ok: true, code: 'account-read' });
  assert.deepEqual(seen, [`https://api.cloudflare.com/client/v4/accounts/${row.target}`]);
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }), new Response(token, { status: 403 }), Response.json({ success: true, result: { id: 'wrong' } }), Response.json({ success: false }), new Response('<html>')]) {
    assert.deepEqual(await verifyConnection(row, token, async () => response), { ok: false, code: 'verification-failed' });
  }
  const replies = [{ id: 12 }, { id: 3, full_name: 'owner/repo', archived: false }, { total_count: 0, workflows: [] }];
  assert.deepEqual(await verifyConnection({ provider: 'github', target: 'owner/repo' }, token, async () => Response.json(replies.shift())), { ok: true, code: 'repository-actions-read' });
});

test('provider bounds oversized and stalled response streams without exposing upstream errors', async () => {
  const row = input();
  const large = new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } });
  assert.equal((await verifyConnection(row, token, async () => large)).ok, false);
  const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } });
  assert.equal((await verifyConnection(row, token, async () => stalled, 30)).ok, false);
  const beforeHeaders = (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error(token)), { once: true }));
  assert.equal((await verifyConnection(row, token, beforeHeaders, 30)).ok, false);
  assert.deepEqual(await verifyConnection(row, token, async () => { throw new Error(token); }), { ok: false, code: 'verification-failed' });
});
