import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { startConfigReview } from '../src/config/server.mjs';
import { compileConfiguration } from '../src/config/compile.mjs';
const source = readFileSync(new URL('../examples/config/services.json', import.meta.url), 'utf8');
async function setup(t) { const app = await startConfigReview(); t.after(() => app.close()); const response = await fetch(app.origin + '/api/session');
  return { ...app, token: (await response.json()).csrf }; }
const headers = app => ({ origin: app.origin, 'content-type': 'application/json', 'x-csrf-token': app.token });
test('config HTTP calls the same compiler, keeps no-store/security headers and fixed static routes', async t => {
  const app = await setup(t);
  assert.match(app.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(app.origin + '/api/validate', { method: 'POST', headers: headers(app), body: source });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), compileConfiguration(JSON.parse(source)));
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  for (const path of ['/../README.md', '/app.js?source=private', '/api/action', '/api/validate']) assert.equal((await fetch(app.origin + path)).status, 404);
  assert.equal((await fetch(app.origin + '/')).status, 200);
});
test('Host, Origin, Fetch Metadata and memory CSRF reject cross-site writes including null origin', async t => {
  const app = await setup(t);
  for (const extra of [{ origin: 'null' }, { origin: 'https://evil.invalid' }, { origin: '' },
    { host: 'localhost:' + new URL(app.origin).port }, { 'sec-fetch-site': 'cross-site' },
    { 'x-csrf-token': 'f'.repeat(64) }, { 'x-csrf-token': 'é'.repeat(64) }, { 'content-type': 'text/plain' }]) {
    assert.equal(await raw(app, req => req.end(source), extra), 403, JSON.stringify(extra));
  }
  assert.equal((await fetch(app.origin + '/api/session', { headers: { origin: 'https://evil.invalid' } })).status, 403);
  const other = await setup(t); assert.notEqual(app.token, other.token);
  assert.equal((await fetch(other.origin + '/api/validate', { method: 'POST', headers: { ...headers(other), 'x-csrf-token': app.token }, body: source })).status, 403);
});
test('invalid input never returns stale valid export, input text, filesystem path or parser details', async t => {
  const app = await setup(t);
  for (const body of ['{"PRIVATE":', '{"secret":"PRIVATE"}', Buffer.from([0xff])]) {
    const response = await fetch(app.origin + '/api/validate', { method: 'POST', headers: headers(app), body });
    assert.equal(response.status, 400); const text = await response.text(); assert.doesNotMatch(text, /PRIVATE|manifestDigest|SyntaxError|at position/);
  }
  const response = await fetch(app.origin + '/api/validate', { method: 'POST', headers: headers(app), body: ' '.repeat(65537) });
  assert.equal(response.status, 413);
});
function raw(app, write, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(app.origin + '/api/validate', { method: 'POST', headers: { ...headers(app), ...extra } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); write(req);
  });
}
test('streamed body byte limit and slow-upload deadline are enforced without trusting Content-Length', async t => {
  const app = await setup(t);
  assert.equal(await raw(app, req => { req.write(' '.repeat(40000)); req.end(' '.repeat(30000)); }), 413);
  assert.equal(await raw(app, req => { req.write('{'); }), 408);
  assert.equal((await fetch(app.origin + '/api/session')).status, 200);
});

test('comparison HTTP shares origin/token protection and does not accept a previous review as authority', async t => {
  const app = await setup(t), baseline = JSON.parse(source), candidate = JSON.parse(source);
  candidate.services = candidate.services.slice(0, 1);
  const body = JSON.stringify({ baseline, candidate });
  assert.equal((await fetch(app.origin + '/api/compare', { method: 'POST', headers: { ...headers(app), origin: 'null' }, body })).status, 403);
  const response = await fetch(app.origin + '/api/compare', { method: 'POST', headers: headers(app), body });
  const { compareConfigurations } = await import('../src/config/compare.mjs');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), compareConfigurations({ baseline, candidate }));
  const invalid = await fetch(app.origin + '/api/compare', { method: 'POST', headers: headers(app), body: JSON.stringify({ baseline: compileConfiguration(baseline), candidate }) });
  assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /reviewDigest/);
  const oversized = await fetch(app.origin + '/api/compare', { method: 'POST', headers: headers(app), body: ' '.repeat(131105) });
  assert.equal(oversized.status, 413);
});
