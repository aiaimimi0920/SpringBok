import { isUuid } from './catalog-contract.mjs';
import { nodeMailboxName } from './node-protocol.mjs';
import { heartbeatInput } from './heartbeat-contract.mjs';

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export const heartbeatEnabled = env => env.ENABLE_NODE_MAILBOX === 'yes' && env.ENABLE_NODE_CREDENTIALS === 'yes' && env.ENABLE_NODE_HEARTBEAT === 'yes' && !!env.NODES;
const nodeFor = (env, context) => env.NODES.get(env.NODES.idFromName(nodeMailboxName(context)));
export async function nodeHeartbeatRequest(request, env, readBody) {
  if (!heartbeatEnabled(env)) return reply({ error: 'node heartbeat disabled' }, 503);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.search || request.headers.has('cookie') || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return reply({ error: 'node heartbeat request denied' }, 403);
  const match = /^\/node\/v2\/heartbeat\/(execute|observe)\/([a-f0-9]{64})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(read|start|sample)$/.exec(url.pathname);
  if (!match || !isUuid(match[3]) || !isUuid(match[4]) || request.method !== 'POST') return reply({ error: 'unknown node heartbeat route' }, 404);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (!token) return reply({ error: 'node heartbeat request denied' }, 403);
  try {
    const context = { ownerId: match[2], nodeId: match[3] }, input = heartbeatInput(match[5], await readBody(request));
    return reply(await nodeFor(env, context).credentialHeartbeat(context, match[1], token[1], match[4], match[5], input));
  } catch { return reply({ error: 'node heartbeat denied or persistence uncertain' }, 409); }
}
export async function adminHeartbeatRequest(request, env, session) {
  if (!heartbeatEnabled(env) || env.ENABLE_CATALOG !== 'yes' || !env.REGISTRY) return reply({ error: 'node heartbeat disabled' }, 503);
  const url = new URL(request.url), match = /^\/api\/admin\/nodes\/([a-f0-9-]{36})\/heartbeat$/.exec(url.pathname);
  if (!match || !isUuid(match[1]) || request.method !== 'GET') return reply({ error: 'unknown node heartbeat route' }, 404);
  if (url.search) return reply({ error: 'node heartbeat query denied' }, 403);
  try {
    const context = { ownerId: session.actor, nodeId: match[1] };
    const catalog = await env.REGISTRY.get(env.REGISTRY.idFromName(`catalog/v1/${session.actor}`)).snapshot(session.actor);
    if (!catalog.servers.some(server => server.id === context.nodeId && ['enrolling', 'active'].includes(server.state))) throw new Error('unavailable node reference');
    return reply(await nodeFor(env, context).adminHeartbeat(context));
  } catch { return reply({ error: 'node heartbeat unknown or persistence uncertain' }, 409); }
}
