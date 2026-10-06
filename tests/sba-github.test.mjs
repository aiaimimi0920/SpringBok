import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubExecutor } from '../src/sba/github.mjs';

const config = () => ({ repository: 'example/control', repositoryId: 10, applicationRepository: 'example/sample',
  workflowId: 20, workflowPath: '.github/workflows/sba-execute.yml', ref: 'main', executorSha: 'b'.repeat(40) });
const manifest = () => ({ schemaVersion: 2, id: 'sample-app', name: 'Sample', version: '1.2.0', entrypoint: 'springbok.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 3600 }, update: { timeoutSeconds: 3600 }, verify: { timeoutSeconds: 120 } }, secrets: [] });
const request = () => ({ schemaVersion: 2, taskId: 'sba-test-01', action: 'deploy', repository: 'example/sample', sourceSha: 'a'.repeat(40),
  applicationId: 'sample-app', applicationVersion: '1.2.0', environment: 'acceptance', configuration: {}, previous: null });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const dispatchResponse = () => ({ workflow_run_id: 30, run_url: 'https://api.github.com/repos/example/control/actions/runs/30',
  html_url: 'https://github.com/example/control/actions/runs/30' });
function client(responses, c = config()) {
  const calls = [];
  const executor = createGithubExecutor(c, { token: 'test-only-private-value', fetchImpl: async (url, options) => {
    calls.push({ url, options }); assert.ok(responses.length, 'unexpected HTTP call');
    const next = responses.shift(); if (next instanceof Error) throw next; return next;
  } });
  return { executor, calls };
}
const run = title => ({ id: 30, workflow_id: 20, event: 'workflow_dispatch', head_sha: 'b'.repeat(40), head_branch: 'main',
  path: '.github/workflows/sba-execute.yml', run_attempt: 1, repository: { id: 10, full_name: 'example/control' },
  head_repository: { id: 10, full_name: 'example/control' }, display_title: title, pull_requests: [], status: 'completed', conclusion: 'success' });
const artifact = name => ({ id: 40, name, expired: false, size_in_bytes: 1000, digest: `sha256:${'c'.repeat(64)}`,
  workflow_run: { id: 30, repository_id: 10, head_repository_id: 10, head_sha: 'b'.repeat(40), head_branch: 'main' } });

test('configuration fixes repository, workflow, executor and reference before any HTTP', () => {
  for (const change of [c => { c.repository = 'https://evil.invalid/a'; }, c => { c.repositoryId = 0; },
    c => { c.workflowId = Number.MAX_SAFE_INTEGER + 1; }, c => { c.workflowPath = '../other.yml'; },
    c => { c.executorSha = 'main'; }, c => { c.ref = '../main'; }, c => { c.applicationRepository = 'a/b/c'; }]) {
    const c = config(); change(c); assert.throws(() => client([], c), /SBA_GITHUB_CONFIGURATION_INVALID/);
  }
  assert.throws(() => createGithubExecutor(config(), { token: 'bad\r\nsecret' }), /SBA_GITHUB_CONFIGURATION_INVALID/);
});

test('preparation binds all public inputs canonically without mutating caller objects', async () => {
  const { executor, calls } = client([]); const r = request(); r.configuration = { z: 2, a: 1 };
  const a = await executor.prepare(r, manifest()); const b = await executor.prepare({ ...r, configuration: { a: 1, z: 2 } }, manifest());
  assert.equal(a.requestDigest, b.requestDigest); assert.match(a.requestDigest, /^[a-f0-9]{64}$/);
  a.request.configuration.a = 99; assert.equal(r.configuration.a, 1);
  assert.notEqual(a.requestDigest, (await executor.prepare({ ...r, environment: 'other-env' }, manifest())).requestDigest);
  await assert.rejects(executor.prepare({ ...r, repository: 'evil/other' }, manifest()), /SBA_GITHUB_REQUEST_INVALID/);
  await assert.rejects(executor.prepare({ ...r, sourceSha: 'main' }, manifest()), /SBA_GITHUB_REQUEST_INVALID/);
  await assert.rejects(executor.prepare({ ...r, configuration: { text: '汉'.repeat(20000) } }, manifest()), /SBA_GITHUB_REQUEST_INVALID/);
  assert.equal(calls.length, 0);
});

function manifestResponses() {
  const bytes = Buffer.from(JSON.stringify(manifest()));
  return [{ sha: 'a'.repeat(40), tree: { sha: '1'.repeat(40) } },
    { sha: '1'.repeat(40), truncated: false, tree: [{ path: '.sba', type: 'tree', mode: '040000', sha: '2'.repeat(40) }] },
    { sha: '2'.repeat(40), truncated: false, tree: [{ path: 'manifest.json', type: 'blob', mode: '100644', sha: '3'.repeat(40) }] },
    { sha: '3'.repeat(40), encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }];
}

test('fixed SHA manifest traverses Git tree modes, never contents symlink or download URLs', async () => {
  const responses = manifestResponses(); responses[3].url = 'https://evil.invalid/steal';
  const c = config(); const { executor, calls } = client(responses.map(json), c); c.applicationRepository = 'changed/repo';
  assert.deepEqual(await executor.readManifest('a'.repeat(40)), manifest());
  assert.deepEqual(calls.map(x => x.url), [
    `https://api.github.com/repos/example/sample/git/commits/${'a'.repeat(40)}`,
    `https://api.github.com/repos/example/sample/git/trees/${'1'.repeat(40)}`,
    `https://api.github.com/repos/example/sample/git/trees/${'2'.repeat(40)}`,
    `https://api.github.com/repos/example/sample/git/blobs/${'3'.repeat(40)}`,
  ]);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers['x-github-api-version'], '2026-03-10');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('manifest rejects symlinks, gitlinks, truncated trees, invalid encoding and legacy contracts', async () => {
  for (const change of [r => { r[0].sha = '9'.repeat(40); }, r => { r[1].truncated = true; },
    r => { r[1].tree[0].mode = '120000'; }, r => { r[1].tree[0].type = 'commit'; },
    r => { r[2].tree[0].mode = '120000'; }, r => { r[2].tree[0].path = 'other'; },
    r => { r[3].sha = '9'.repeat(40); }, r => { r[3].size = 65537; }, r => { r[3].size--; },
    r => { r[3].encoding = 'none'; }, r => { r[3].content = '%%%'; },
    r => { r[3].content = Buffer.from([255]).toString('base64'); r[3].size = 1; },
    r => { const b = Buffer.from(JSON.stringify({ ...manifest(), schemaVersion: 1 })); r[3].content = b.toString('base64'); r[3].size = b.length; }]) {
    const responses = manifestResponses(); change(responses); const { executor } = client(responses.map(json));
    await assert.rejects(executor.readManifest('a'.repeat(40)), /SBA_GITHUB_MANIFEST_INVALID/);
  }
  await assert.rejects(client([]).executor.readManifest('main'), /SBA_GITHUB_REQUEST_INVALID/);
});
test('single dispatch returns exact run ID, full request digest and fixed workflow inputs', async () => {
  const { executor, calls } = client([json(dispatchResponse())]);
  const result = await executor.dispatch(request(), manifest());
  assert.equal(result.status, 'dispatched'); assert.equal(result.runId, 30); assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://api.github.com/repos/example/control/actions/workflows/20/dispatches');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(sent.return_run_details, true);
  assert.equal(sent.ref, 'main'); assert.equal(sent.inputs.executor_sha, config().executorSha);
  assert.equal(sent.inputs.request_sha256, result.requestDigest); assert.deepEqual(JSON.parse(sent.inputs.request_json), request());
  assert.ok(!JSON.stringify(sent).includes('test-only-private-value'));
});

test('every post-send failure is unknown without retry, secret error body or redirect fallback', async () => {
  for (const response of [new Error('test-only-private-value'), new Response(null, { status: 204 }),
    new Response('test-only-private-value', { status: 403 }), new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    new Response('{bad'), json(null), json([]), json({ ...dispatchResponse(), workflow_run_id: 0 }),
    json({ ...dispatchResponse(), run_url: 'https://evil.invalid' }), json({ ...dispatchResponse(), html_url: 'https://github.com/other/repo' }),
    new Response('x'.repeat(262145))]) {
    const { executor, calls } = client([response]); const result = await executor.dispatch(request(), manifest());
    assert.equal(result.status, 'unknown'); assert.equal(result.runId, null); assert.equal(calls.length, 1);
    assert.equal(result.errorCode, 'SBA_GITHUB_DISPATCH_UNKNOWN'); assert.ok(!JSON.stringify(result).includes('test-only-private-value'));
  }
  const { executor, calls } = client([]);
  await assert.rejects(executor.dispatch({ ...request(), repository: 'other/app' }, manifest()), /SBA_GITHUB_REQUEST_INVALID/);
  assert.equal(calls.length, 0);
});

test('exact run inspection offers a receipt candidate, never application success', async () => {
  const responses = []; const { executor, calls } = client(responses); const binding = await executor.prepare(request(), manifest());
  responses.push(json(run(binding.title)), json({ total_count: 1, artifacts: [artifact(binding.artifactName)] }));
  const value = await executor.inspectRun(30, request(), manifest());
  assert.equal(value.status, 'receipt-available'); assert.equal(value.artifact.id, 40); assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.github.com/repos/example/control/actions/runs/30/artifacts?per_page=100');
  assert.equal(value.requestDigest, binding.requestDigest);
});

test('wrong run, fork, SHA, branch, workflow, task digest and rerun are rejected before artifacts', async () => {
  const changes = [r => { r.id++; }, r => { r.workflow_id++; }, r => { r.event = 'pull_request'; }, r => { r.head_sha = 'a'.repeat(40); },
    r => { r.head_branch = 'other'; }, r => { r.path = '.github/workflows/other.yml'; }, r => { r.run_attempt = 2; },
    r => { r.repository.id++; }, r => { r.repository.full_name = 'other/repo'; }, r => { r.head_repository.id++; },
    r => { r.head_repository.full_name = 'other/repo'; }, r => { r.display_title = 'other-task'; }, r => { r.pull_requests = [{}]; }];
  for (const change of changes) {
    const responses = []; const { executor, calls } = client(responses); const binding = await executor.prepare(request(), manifest());
    const value = run(binding.title); change(value); responses.push(json(value));
    await assert.rejects(executor.inspectRun(30, request(), manifest()), /SBA_GITHUB_RUN_IDENTITY_INVALID/); assert.equal(calls.length, 1);
  }
});

test('pending, cancelled, failed or unknown runs never fetch artifacts or claim deployment success', async () => {
  for (const [status, conclusion, expected] of [['queued', null, 'pending'], ['in_progress', null, 'pending'], ['waiting', null, 'pending'],
    ['completed', 'failure', 'unknown'], ['completed', 'cancelled', 'unknown'], ['completed', 'timed_out', 'unknown'], ['new-status', null, 'unknown']]) {
    const responses = []; const { executor, calls } = client(responses); const binding = await executor.prepare(request(), manifest());
    responses.push(json({ ...run(binding.title), status, conclusion }));
    assert.equal((await executor.inspectRun(30, request(), manifest())).status, expected); assert.equal(calls.length, 1);
  }
});

test('artifact ownership, digest, size, uniqueness and bounded complete list must all match', async () => {
  const changes = [a => { a.id = 0; }, a => { a.name = 'other'; }, a => { a.expired = true; }, a => { a.size_in_bytes = 65537; },
    a => { a.size_in_bytes = 0; }, a => { a.digest = 'unknown'; }, a => { a.workflow_run.id++; },
    a => { a.workflow_run.repository_id++; }, a => { a.workflow_run.head_repository_id++; },
    a => { a.workflow_run.head_sha = 'a'.repeat(40); }, a => { a.workflow_run.head_branch = 'other'; }];
  for (const change of changes) {
    const responses = []; const { executor } = client(responses); const binding = await executor.prepare(request(), manifest());
    const a = artifact(binding.artifactName); change(a);
    responses.push(json(run(binding.title)), json({ total_count: 1, artifacts: [a] }));
    await assert.rejects(executor.inspectRun(30, request(), manifest()), /SBA_GITHUB_ARTIFACT_INVALID/);
  }
  for (const count of [0, 2, 101]) {
    const responses = []; const { executor } = client(responses); const binding = await executor.prepare(request(), manifest());
    const artifacts = count === 2 ? [artifact(binding.artifactName), artifact(binding.artifactName)] : [];
    responses.push(json(run(binding.title)), json({ total_count: count, artifacts }));
    await assert.rejects(executor.inspectRun(30, request(), manifest()), /SBA_GITHUB_ARTIFACT_INVALID/);
  }
});

test('invalid UTF-8 responses expose only fixed read error codes', async () => {
  const { executor, calls } = client([new Response(new Uint8Array([255]))]);
  await assert.rejects(executor.readManifest('a'.repeat(40)), /SBA_GITHUB_RESPONSE_INVALID/);
  assert.equal(calls.length, 1);
});

test('body deadline aborts a stalled dispatch response once and keeps the outcome unknown', async () => {
  let calls = 0; let aborted = false;
  const executor = createGithubExecutor(config(), { token: 'test-only-private-value', fetchImpl: async (_url, { signal }) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('test-only-private-value')); }, { once: true });
    } }));
  } });
  const result = await executor.dispatch(request(), manifest());
  assert.equal(aborted, true); assert.equal(calls, 1); assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('test-only-private-value'));
});

test('moved executor ref is rejected on inspection, not falsely described as pre-dispatch protection', async () => {
  const responses = [json(dispatchResponse())]; const { executor, calls } = client(responses);
  const binding = await executor.prepare(request(), manifest());
  assert.equal((await executor.dispatch(request(), manifest())).status, 'dispatched');
  responses.push(json({ ...run(binding.title), head_sha: 'f'.repeat(40) }));
  await assert.rejects(executor.inspectRun(30, request(), manifest()), /SBA_GITHUB_RUN_IDENTITY_INVALID/);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});

test('separate dispatch invocations are not an idempotency layer; durable claim is mandatory', async () => {
  const { executor, calls } = client([json(dispatchResponse()), json(dispatchResponse())]);
  await executor.dispatch(request(), manifest()); await executor.dispatch(request(), manifest());
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 2);
});
