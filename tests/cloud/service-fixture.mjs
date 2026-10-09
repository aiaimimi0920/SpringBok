import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectedFixture } from './connected-fixture.mjs';
import { manifest, sourceSha } from './sba-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';

export const updatedSha = 'c'.repeat(40), invalidSha = 'd'.repeat(40);
export async function serviceFixture(overrides={}) {
  const fixture = await connectedFixture(overrides), { f, state, session } = fixture, prior = state.provider;
  const metadata = repository => ({ id: repository === 'owner/repo' ? 2 : repository === 'owner/second' ? 3 : 4, full_name: repository, default_branch: 'main' });
  state.repositoryPages = [[...['owner/repo', 'owner/second', 'owner/empty', 'owner/broken'].map(metadata)]];
  state.tagPages = [[{ name: 'v2.0.0', commit: { sha: updatedSha } }, { name: 'v1.0.0', commit: { sha: sourceSha } }]];
  state.headSha = sourceSha; state.invalidSba = new Set(['owner/broken']); state.missingSba = new Set(['owner/empty']);
  state.provider = async (request, context) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/actions/workflows/99/dispatches')) state.runStatus = 'in_progress';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user/repos') return Response.json(state.repositoryPages[Number(url.searchParams.get('page')) - 1] ?? []);
    const match = url.pathname.match(/^\/repos\/(owner\/[^/]+)(.*)$/), repository = match?.[1], suffix = match?.[2];
    if (match && repository !== 'owner/executor') {
      if (suffix === '') return Response.json(metadata(repository));
      if (suffix === '/git/ref/heads/main') return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: state.headSha } });
      if (suffix === '/tags') return Response.json(state.tagPages[Number(url.searchParams.get('page')) - 1] ?? []);
      if (suffix === '/git/trees/main') return Response.json({ sha: '1'.repeat(40), truncated: false,
        tree: state.missingSba.has(repository) ? [] : [{ path: '.sba', type: 'tree', mode: '040000', sha: '2'.repeat(40) }] });
      if (suffix.startsWith('/git/')) {
        const requested = suffix.split('/').at(-1), updated = requested === updatedSha || ['5', '6', '7', '8'].some(char => requested === char.repeat(40));
        const root = (updated ? '5' : '1').repeat(40), directory = (updated ? '6' : '2').repeat(40), manifestBlob = (updated ? '7' : '3').repeat(40), declarationBlob = (updated ? '8' : '4').repeat(40);
        if (suffix.startsWith('/git/commits/')) return Response.json({ sha: requested, tree: { sha: root } });
        if (suffix === '/git/trees/' + root) return Response.json({ sha: root, truncated: false, tree: state.missingSba.has(repository) ? [] : [{ path: '.sba', type: 'tree', mode: '040000', sha: directory }] });
        if (suffix === '/git/trees/' + directory) return Response.json({ sha: directory, truncated: false, tree: [
          { path: 'manifest.json', type: 'blob', mode: state.invalidSba.has(repository) ? '120000' : '100644', sha: manifestBlob },
          { path: 'deployment.json', type: 'blob', mode: '100644', sha: declarationBlob },
        ] });
        const app = { ...manifest, version: updated ? (state.updateVersion ?? '2.0.0') : '1.0.0', ...(repository === 'owner/second' ? { id: 'second-app', name: '第二个服务' } : {}),
          actions: { ...manifest.actions, update: { timeoutSeconds: 120 } }, ...state.manifestOverride };
        const declaration = structuredClone(state.declaration);
        if (repository === 'owner/second') { declaration.fields.push({ path: ['region'], label: '区域', type: 'text', required: true }); declaration.defaults.region = 'test-region'; }
        if (updated && state.updateDeclaration) Object.assign(declaration, state.updateDeclaration);
        for (const [hash, value] of [[manifestBlob, app], [declarationBlob, declaration]]) if (suffix === '/git/blobs/' + hash) {
          const bytes = Buffer.from(JSON.stringify(value)); return Response.json({ sha: hash, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
        }
      }
    }
    if (url.href === 'https://api.cloudflare.com/client/v4/graphql') {
      const body = await request.json(), day = body.variables.start.slice(0, 10);
      const samples = body.query.includes('workersInvocationsAdaptive') ? [{ dimensions: { scriptName: 'test-worker' }, sum: { requests: 24 } }, { dimensions: { scriptName: 'unrelated-worker' }, sum: { requests: 999 } }] :
        [{ dimensions: { databaseId: fixture.resource.remoteId, date: day }, max: { databaseSizeBytes: 20000000 } }, { dimensions: { databaseId: '00000000-0000-0000-0000-000000000000', date: day }, max: { databaseSizeBytes: 888000000 } }];
      return Response.json({ data: { viewer: { accounts: [{ samples }] } } });
    }
    return prior(request, context);
  };
  const id = randomUUID(), result = await f.call('/api/admin/connections', { ...session, body: { action: 'connect', id, name: 'GitHub 账户', provider: 'github', token: fakeToken, accountId: '' } });
  assert.equal(result.status, 200, result.text);
  const github = { id, revision: 1 }, service = (route, body) => f.call('/api/admin/deployments/' + route, { ...session, ...(body ? { body } : {}) });
  return { ...fixture, github, service };
}
