import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adminFixture, origin } from './admin-fixture.mjs';
import { sbaDigest } from '../../cloud/sba-control.mjs';
import { zip } from '../sba-zip-fixture.mjs';
const sha = 'a'.repeat(40), sourceSha = 'b'.repeat(40);
const policy = { github: { repository: 'owner/executor', repositoryId: 123, applicationRepository: 'owner/application', workflowId: 99,
  workflowPath: '.github/workflows/sba-execute.yml', executorSha: sha, ref: `sba-executor-${sha}` },
  sourceSha, environment: 'staging', configuration: {}, secretNames: ['CLOUDFLARE_API_TOKEN'], runnerOrigin: 'https://runner.example.invalid' };
const manifest = { schemaVersion: 2, id: 'sample-app', name: 'Sample', version: '1.0.0', entrypoint: 'entry.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 60 } }, secrets: policy.secretNames };
export async function sbaFixture(t, overrides = {}) {
  const state = { urls: [], dispatches: 0, title: null, requestDigest: null, runStatus: 'in_progress', archive: null, badTitle: false, networkDown: false, dispatchLost: false };
  const f = await adminFixture({ ENABLE_SBA: 'yes', SBA_POLICY: JSON.stringify(policy), SBA_GITHUB_TOKEN: 'synthetic-github',
    SBA_APPLICATION_SECRETS: JSON.stringify({ CLOUDFLARE_API_TOKEN: 'synthetic-deployment-secret', UNRELATED_SECRET: 'never-return' }), ...overrides },
  { sba: true, outbound: async (request, { jwk }) => {
    const url = request.url; state.urls.push(url);
    if (url === 'https://token.actions.githubusercontent.com/.well-known/jwks') return Response.json({ keys: [jwk] });
    if (state.networkDown) return new Response(null, { status: 503 });
    if (url.startsWith('https://api.github.com/')) assert.equal(request.headers.get('authorization'), 'Bearer synthetic-github');
    if (url.endsWith(`/git/commits/${sourceSha}`)) return Response.json({ sha: sourceSha, tree: { sha: '1'.repeat(40) } });
    if (url.endsWith(`/git/trees/${'1'.repeat(40)}`)) return Response.json({ sha: '1'.repeat(40), truncated: false, tree: [{ path: '.sba', type: 'tree', mode: '040000', sha: '2'.repeat(40) }] });
    if (url.endsWith(`/git/trees/${'2'.repeat(40)}`)) return Response.json({ sha: '2'.repeat(40), truncated: false, tree: [{ path: 'manifest.json', type: 'blob', mode: '100644', sha: '3'.repeat(40) }] });
    if (url.endsWith(`/git/blobs/${'3'.repeat(40)}`)) {
      const bytes = Buffer.from(JSON.stringify(manifest)); return Response.json({ sha: '3'.repeat(40), encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
    }
    if (url.endsWith('/actions/workflows/99/dispatches')) {
      state.dispatches++; const body = await request.json();
      assert.equal(body.ref, policy.github.ref); assert.equal(body.inputs.executor_sha, sha);
      state.request = JSON.parse(body.inputs.request_json); state.requestDigest = body.inputs.request_sha256;
      state.title = `sba:${state.request.taskId}:${state.requestDigest}`;
      if (state.dispatchLost) return new Response(null, { status: 503 });
      return Response.json({ workflow_run_id: 456, run_url: 'https://api.github.com/repos/owner/executor/actions/runs/456', html_url: 'https://github.com/owner/executor/actions/runs/456' });
    }
    if (url.endsWith('/actions/runs/456')) return Response.json({ id: 456, workflow_id: 99, event: 'workflow_dispatch', head_sha: sha, head_branch: policy.github.ref,
      path: policy.github.workflowPath, run_attempt: 1, repository: { id: 123, full_name: policy.github.repository }, head_repository: { id: 123, full_name: policy.github.repository },
      display_title: state.badTitle ? 'wrong-task' : state.title, pull_requests: [], status: state.runStatus, conclusion: state.runStatus === 'completed' ? 'success' : null });
    if (url.endsWith('/actions/runs/456/artifacts?per_page=100')) return Response.json({ total_count: 1, artifacts: [{ id: 789,
      name: `sba-result-${state.request.taskId}-${state.requestDigest}`, expired: false, size_in_bytes: state.archive.length,
      digest: `sha256:${createHash('sha256').update(state.archive).digest('hex')}`,
      workflow_run: { id: 456, repository_id: 123, head_repository_id: 123, head_sha: sha, head_branch: policy.github.ref } }] });
    if (url.endsWith('/actions/artifacts/789/zip')) return new Response(null, { status: 302, headers: { location: 'https://synthetic.blob.core.windows.net/receipt?sig=synthetic' } });
    if (url === 'https://synthetic.blob.core.windows.net/receipt?sig=synthetic') {
      assert.equal(request.headers.get('authorization'), null); return new Response(state.archive);
    }
    return new Response(null, { status: 503 });
  } });
  t.after(() => f.close());
  const session = f.jwt(), adminState = (await f.call('/api/admin/state', { token: session })).json();
  const post = (path, body, extra = {}) => f.call(`/api/admin/sba/${path}`, { token: session, body, headers: { 'x-csrf-token': adminState.csrf }, ...extra });
  const preview = async () => { const r = await post('preview', { taskId: 'sba-test-task' }); assert.equal(r.status, 200, JSON.stringify({ calls: state.urls, response: r.text })); return r.json(); };
  const token = (changes = {}) => {
    const now = Math.floor(Date.now() / 1000), ref = `refs/tags/${policy.github.ref}`;
    return f.jwt({ iss: 'https://token.actions.githubusercontent.com', aud: `${policy.runnerOrigin}/sba/v2/permit`, sub: `repo:${policy.github.repository}:ref:${ref}`,
      jti: 'synthetic', iat: now, nbf: now, exp: now + 300, repository: policy.github.repository, repository_id: '123', workflow_sha: sha, sha,
      ref, ref_type: 'tag', workflow_ref: `${policy.github.repository}/${policy.github.workflowPath}@${ref}`, event_name: 'workflow_dispatch',
      runner_environment: 'github-hosted', run_id: '456', run_attempt: '1', ...changes });
  };
  const permit = async (jwt = token(), body = { taskId: state.request?.taskId ?? 'sba-test-task', requestDigest: state.requestDigest }, url = `${policy.runnerOrigin}/sba/v2/permit`) => {
    const response = await f.mf.dispatchFetch(url, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  return { f, state, post, preview, permit, token, adminState, session };
}

export { policy, manifest, sha, sourceSha };
