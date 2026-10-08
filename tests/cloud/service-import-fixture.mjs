import { serviceFixture } from './service-fixture.mjs';
import { sourceSha } from './sba-fixture.mjs';

export function importProvider(fixture) {
  const { state, resource } = fixture, prior = state.provider;
  state.resources = null;
  state.importBindings = [{ name: 'DB', type: 'd1', id: resource.remoteId }, { name: 'SECRET', type: 'secret_text', text: 'never-return-this' }];
  state.importDomains = [{ service: 'test-worker', hostname: 'test.example.invalid' }];
  state.importDenied = null;
  state.provider = async (request, context) => {
    const url = new URL(request.url), prefix = '/client/v4/accounts/' + 'a'.repeat(32), path = url.pathname.slice(prefix.length);
    if (url.origin === 'https://api.cloudflare.com' && url.pathname.startsWith(prefix)) {
      if (path === state.importDenied) return Response.json({ secret: 'never-return-this' }, { status: 403 });
      const result = path === '/workers/scripts' ? [{ id: 'test-worker' }, { id: 'other-worker' }] :
        /^\/workers\/scripts\/(test-worker|other-worker)\/settings$/.test(path) ? { bindings: state.importBindings } :
        path === '/workers/domains' ? state.importDomains :
        path === '/d1/database/' + resource.remoteId ? { uuid: resource.remoteId, name: 'test-database' } :
        path === '/storage/kv/namespaces' ? [{ id: '1'.repeat(32), title: 'test-kv' }] :
        path === '/r2/buckets/test-bucket' ? { name: 'test-bucket' } : undefined;
      if (result !== undefined) return Response.json({ success: true, result });
    }
    return prior(request, context);
  };
  return { github: fixture.github, repository: 'owner/repo', sourceSha, cloudflare: fixture.input.cloudflare, components: { 'server.name': 'test-worker' } };
}
export async function importFixture() {
  const fixture = await serviceFixture(); return { ...fixture, draft: importProvider(fixture) };
}
