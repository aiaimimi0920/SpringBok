import { nodeMailboxName } from './node-protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { channelInput } from './node-channel-contract.mjs';
import { signSession, sameProof } from './access.mjs';

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export const channelEnabled = env => env.ENABLE_NODE_MAILBOX === 'yes' && env.ENABLE_NODE_CREDENTIALS === 'yes' && env.ENABLE_NODE_CHANNEL === 'yes' && !!env.NODES;
const nodeFor = (env, context) => env.NODES.get(env.NODES.idFromName(nodeMailboxName(context)));
export async function nodeChannelRequest(request, env, readBody) {
  if (!channelEnabled(env)) return reply({ error: 'node channel disabled' }, 503);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.search || request.headers.has('cookie') || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return reply({ error: 'node channel request denied' }, 403);
  const match = /^\/node\/v2\/channel\/(execute|observe)\/([a-f0-9]{64})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(poll|report)$/.exec(url.pathname);
  if (!match || !isUuid(match[3]) || !isUuid(match[4]) || request.method !== 'POST') return reply({ error: 'unknown node channel route' }, 404);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (!token) return reply({ error: 'node channel request denied' }, 403);
  try {
    const context = { ownerId: match[2], nodeId: match[3] }, input = channelInput(match[5], await readBody(request));
    return reply(await nodeFor(env, context).credentialProbe(context, match[1], token[1], match[4], match[5], input));
  } catch { return reply({ error: 'node channel denied or persistence uncertain' }, 409); }
}
export async function adminNodeProbeRequest(request, env, session, readBody) {
  if (!channelEnabled(env) || env.ENABLE_CATALOG !== 'yes' || !env.REGISTRY) return reply({ error: 'node probe disabled' }, 503);
  const url = new URL(request.url), match = /^\/api\/admin\/nodes\/([a-f0-9-]{36})\/probe$/.exec(url.pathname);
  if (!match || !isUuid(match[1]) || !['GET', 'POST'].includes(request.method)) return reply({ error: 'unknown node probe route' }, 404);
  if (url.search || (request.method === 'POST' && (request.headers.get('origin') !== session.origin || !sameProof(request.headers.get('x-csrf-token'), await signSession(session, 'csrf', null))))) return reply({ error: 'refresh this authenticated session' }, 403);
  try {
    const context = { ownerId: session.actor, nodeId: match[1] };
    const catalog = await env.REGISTRY.get(env.REGISTRY.idFromName(`catalog/v1/${session.actor}`)).snapshot(session.actor);
    if (!catalog.servers.some(server => server.id === context.nodeId && ['enrolling', 'active'].includes(server.state))) throw new Error('unavailable node reference');
    return reply(await nodeFor(env, context).adminProbe(context, request.method === 'GET' ? 'snapshot' : 'submit', request.method === 'GET' ? null : await readBody(request)));
  } catch { return reply({ error: 'node probe rejected, stale or persistence uncertain' }, 409); }
}
