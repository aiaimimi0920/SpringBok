import { sameProof, signSession } from './access.mjs';
import { validVaultKey } from './connections-contract.mjs';
export const connectionsEnabled = env => env.ENABLE_CONNECTIONS === 'yes' && !!env.CONNECTIONS && validVaultKey(env.CONNECTIONS_ENCRYPTION_KEY);
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export async function adminConnectionsRequest(request, env, session, readBody) {
  if (session.automation) return reply({ error: 'access-denied' }, 403);
  if (!connectionsEnabled(env)) return reply({ error: 'connections-disabled' }, 503);
  const path = new URL(request.url).pathname, resources = path === '/api/admin/resources';
  if (!['GET', 'POST'].includes(request.method) || !['/api/admin/connections','/api/admin/resources'].includes(path)) return reply({ error: 'unknown-route' }, 404);
  if (request.method === 'POST' && (request.headers.get('origin') !== session.origin || !sameProof(request.headers.get('x-csrf-token'), await signSession(session, 'csrf', null)))) return reply({ error: 'refresh-session' }, 403);
  try {
    const vault = env.CONNECTIONS.get(env.CONNECTIONS.idFromName(`connections/v1/${session.actor}`));
    const result = request.method === 'GET' ? await vault[resources ? 'resourceSnapshot' : 'snapshot'](session.actor) : await vault[resources ? 'resourceOperation' : 'mutate'](session.actor, await readBody(request));
    return reply(result, result.error ? 422 : 200);
  } catch { return reply({ error: 'connection-rejected-refresh-before-retry' }, 409); }
}
