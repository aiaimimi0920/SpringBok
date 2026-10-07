import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sourceWant, githubSourcePack, requestSource, decodeSourceResponse, SOURCE_CONTENT_TYPE, MAX_SOURCE_BYTES } from '../src/sba/source.mjs';
import { sourceDiagnostic, sourceMedia, sbaDiagnosticHeaders } from '../src/sba/diagnostics.mjs';
const sha = 'a'.repeat(40);
const packet = input => { const b = Buffer.from(input); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const packHead = Buffer.concat([Buffer.from('PACK'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), Buffer.from('synthetic-object')]);
const pack = Buffer.concat([packHead, createHash('sha1').update(packHead).digest()]);
const wire = (value = pack, channel = 1, source = sha) => Buffer.concat([
  packet(`shallow ${source}\n`), Buffer.from('0000'), packet('NAK\n'), packet(Buffer.concat([Buffer.from([channel]), value])), Buffer.from('0000'),
]);
test('source broker sends only the configured repository and fixed shallow want, without redirects', async () => {
  let calls = 0;
  const bytes = await githubSourcePack('owner/application', sha, 'synthetic-github', { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://github.com/owner/application.git/git-upload-pack');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, `Basic ${Buffer.from('x-access-token:synthetic-github').toString('base64')}`);
    assert.equal(options.body, sourceWant(sha)); assert.doesNotMatch(options.body, /synthetic|have |filter /);
    assert.match(options.body, /deepen 1\n00000009done\n$/);
    return new Response(wire(), { headers: { 'content-type': SOURCE_CONTENT_TYPE } });
  } });
  assert.equal(calls, 1); assert.deepEqual(Buffer.from(bytes), wire());
  for (const [repository, source, token] of [['owner/../other', sha, 'x'], ['owner/application', 'main', 'x'], ['owner/application', sha, 'bad\r\nheader']])
    assert.throws(() => githubSourcePack(repository, source, token), /SBA_SOURCE_REJECTED/);
});
test('source reader rejects redirect, wrong MIME, oversize, interrupted streams and never retries', async () => {
  for (const response of [new Response('secret', { status: 302, headers: { location: 'https://evil.invalid' } }),
    new Response('secret', { headers: { 'content-type': 'text/plain' } }),
    new Response(new Uint8Array(MAX_SOURCE_BYTES + 1), { headers: { 'content-type': SOURCE_CONTENT_TYPE } }),
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('secret')); } }), { headers: { 'content-type': SOURCE_CONTENT_TYPE } })]) {
    let calls = 0;
    await assert.rejects(requestSource('https://runner.example.invalid/sba/v2/source', { headers: {}, body: '{}', fetchImpl: async () => { calls++; return response; } }), /^Error: SBA_SOURCE_REJECTED$/);
    assert.equal(calls, 1);
  }
});
test('source timeout aborts a pending request without retrying or revealing upstream errors', { timeout: 20000 }, async () => {
  let calls = 0, signal;
  await assert.rejects(requestSource('https://runner.example.invalid/sba/v2/source', {
    headers: {}, body: '{}', fetchImpl: async (_url, options) => {
      calls++; signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic-private-error')), { once: true }));
    },
  }), /^Error: SBA_SOURCE_REJECTED$/);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
test('source frames bind shallow SHA, pack checksum, terminal flush and bounded protocol', async () => {
  assert.deepEqual(Buffer.from((await decodeSourceResponse(wire(), sha)).pack), pack);
  assert.deepEqual(Buffer.from((await decodeSourceResponse(wire(Buffer.concat([pack, Buffer.from('\n')])), sha)).pack), pack);
  const corrupt = Buffer.from(pack); corrupt[13] ^= 1;
  for (const bytes of [wire(corrupt), wire(pack, 2), wire(pack, 3), wire(pack, 1, 'b'.repeat(40)),
    Buffer.concat([wire(), Buffer.from('0000')]), wire().subarray(0, -1), Buffer.from('ffff'),
    wire(Buffer.concat([pack, Buffer.from('unexpected')])), new Uint8Array(MAX_SOURCE_BYTES + 1)])
    await assert.rejects(decodeSourceResponse(bytes, sha), /^Error: SBA_SOURCE_REJECTED$/);
});

test('source diagnostics distinguish transport failures using only fixed metadata and never body or arbitrary headers', async () => {
  for (const [response, reason] of [[new Response('synthetic-private-body', { status: 403,
    headers: { 'content-type': 'application/json', ...sbaDiagnosticHeaders({ phase: 'oidc', reason: 'executor' }) } }), 'http'],
    [new Response('synthetic-private-body', { headers: { 'content-type': 'text/html' } }), 'media'],
    [new Response(null, { headers: { 'content-type': SOURCE_CONTENT_TYPE } }), 'body-missing'],
    [new Response('', { headers: { 'content-type': SOURCE_CONTENT_TYPE } }), 'body-empty'],
    [new Response(new Uint8Array(MAX_SOURCE_BYTES + 1), { headers: { 'content-type': SOURCE_CONTENT_TYPE } }), 'body-size'],
    [new Response(new ReadableStream({ start(c) { c.error(new Error('synthetic-private-error')); } }), { headers: { 'content-type': SOURCE_CONTENT_TYPE } }), 'body-read']]) {
    let detail, calls = 0;
    await assert.rejects(requestSource('https://runner.example.invalid/sba/v2/source', { headers: {}, body: '{}',
      fetchImpl: async () => { calls++; return response; }, onFailure: value => { detail = value; } }), /^Error: SBA_SOURCE_REJECTED$/);
    assert.equal(detail.reason, reason); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(detail), /synthetic-private/);
    if (response.status === 403) assert.equal(detail.remotePhase, 'oidc');
  }
  const hostile = new Response('private', { status: 403, headers: { 'content-type': 'private/type',
    'x-sba-denied-phase': 'private-secret', 'x-sba-denied-reason': 'private-error',
    'x-sba-upstream-status': 'private-status', 'x-sba-upstream-media': 'private-media' } });
  assert.doesNotMatch(JSON.stringify(sourceDiagnostic(hostile, 'private-reason')), /private/);
  assert.equal(sourceMedia('__proto__'), 'other'); assert.equal(sourceMedia('constructor'), 'other');
  let detail;
  await assert.rejects(requestSource('https://runner.example.invalid', { fetchImpl: async () => { throw new Error('private-error'); },
    onFailure: value => { detail = value; } }), /^Error: SBA_SOURCE_REJECTED$/);
  assert.equal(detail.reason, 'network'); assert.equal(detail.httpStatus, null);
});
