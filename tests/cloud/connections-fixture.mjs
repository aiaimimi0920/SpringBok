import { adminFixture } from './admin-fixture.mjs';
export const fakeToken = 'synthetic-connection-token-for-tests-only';
export async function connectionsFixture(overrides = {}) {
  const state = { reject: false, requests: [], hold: null, onRequest: null, resources: null, provider: null };
  const f = await adminFixture({ ENABLE_CONNECTIONS: 'yes', CONNECTIONS_ENCRYPTION_KEY: '7'.repeat(64), ...overrides }, {
    connections: true, sba: overrides.ENABLE_SBA === 'yes', entryPoint: 'tests/cloud/connections-storage-fixture.mjs',
    outbound: async (request, context) => {
      state.requests.push({ method: request.method, url: request.url });
      state.onRequest?.(); if (state.hold) await state.hold;
      if (state.reject) return Response.json({ error: fakeToken }, { status: 403 });
      if (state.resources && request.url.startsWith('https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/')) return Response.json(state.resources);
      if (request.url === 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32)) return Response.json({ success: true, result: { id: 'a'.repeat(32) } });
      if (request.url === 'https://api.github.com/user') return Response.json({ id: 1 });
      if (request.url === 'https://api.github.com/repos/owner/repo') return Response.json({ id: 2, full_name: 'owner/repo' });
      if (request.url === 'https://api.github.com/repos/owner/repo/actions/workflows?per_page=1') return Response.json({ total_count: 1, workflows: [{ id: 3 }] });
      if (state.provider) return state.provider(request,context);
      return Response.json({}, { status: 404 });
    },
  });
  return { f, state };
}
