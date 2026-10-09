export function deletionProvider(suite) {
  const { state, resource } = suite, prior = state.provider;
  state.resources = null;
  const live = { worker: true, database: true, domain: true, kv: false, shared: false, pagesShared: false, lost: false, deletes: [], modified: '2026-10-08T00:00:00Z' };
  state.provider = async (request, context) => {
    const url = new URL(request.url), prefix = '/client/v4/accounts/' + 'a'.repeat(32), path = url.pathname.slice(prefix.length);
    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith(prefix)) return prior(request, context);
    const ok = result => Response.json({ success: true, result });
    if (request.method === 'DELETE') {
      live.deletes.push(path);
      if (path === '/workers/domains/' + 'd'.repeat(32)) live.domain = false;
      else if (path === '/workers/scripts/test-worker') { live.worker = false; if (live.lost) return new Response(null, { status: 503 }); }
      else if (path === '/d1/database/' + resource.remoteId) live.database = false;
      else if (path === '/storage/kv/namespaces/' + '1'.repeat(32)) live.kv = false;
      else return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    }
    if (request.method !== 'GET') return prior(request, context);
    if (path === '/workers/scripts') return ok([...(live.worker ? [{ id: 'test-worker', modified_on: live.modified }] : []), { id: 'unrelated-worker', modified_on: live.modified }]);
    if (path === '/pages/projects') return ok(live.pagesShared || live.pagesDeployments ? [{ name: 'other-pages', deployment_configs: { production: { d1_databases: live.pagesShared ? { DB: { id: resource.remoteId } } : {} } } }] : []);
    if (path === '/pages/projects/other-pages/deployments') return ok(live.pagesDeployments ?? []);
    if (path === '/workers/domains') return ok(live.domain ? [{ id: 'd'.repeat(32), hostname: 'app.example.invalid', service: 'test-worker' }] : []);
    if (path.endsWith('/settings')) return ok({ bindings: path.includes('/test-worker/') || live.shared ? [{ type: 'd1', id: resource.remoteId, name: 'DB' }] : [] });
    if (path === '/d1/database') return ok(live.database ? [{ uuid: resource.remoteId, name: resource.name }] : []);
    if (path === '/storage/kv/namespaces') return ok(live.kv ? [{ id: '1'.repeat(32), title: 'test-kv' }] : []);
    return prior(request, context);
  };
  return live;
}
