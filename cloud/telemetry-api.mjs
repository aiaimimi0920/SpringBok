import { isUuid } from './catalog-contract.mjs';
import { nodeMailboxName } from './node-protocol.mjs';
import { authorizedTelemetry, telemetryName, telemetryInput, telemetrySnapshot } from './telemetry-contract.mjs';

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export const telemetryEnabled = env => env.ENABLE_NODE_MAILBOX === 'yes' && env.ENABLE_NODE_CREDENTIALS === 'yes' && env.ENABLE_NODE_TELEMETRY === 'yes' && !!env.NODES && !!env.TELEMETRY;
const nodeFor = (env, context) => env.NODES.get(env.NODES.idFromName(nodeMailboxName(context)));
const telemetryFor = (env, context) => env.TELEMETRY.get(env.TELEMETRY.idFromName(telemetryName(context)));
export async function nodeTelemetryRequest(request, env, readBody) {
  if (!telemetryEnabled(env)) return reply({ error: 'node telemetry disabled' }, 503);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.search || request.headers.has('cookie') || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return reply({ error: 'node telemetry request denied' }, 403);
  const match = /^\/node\/v2\/telemetry\/observe\/([a-f0-9]{64})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(read|start|sample)$/.exec(url.pathname);
  if (!match || !isUuid(match[2]) || !isUuid(match[3]) || request.method !== 'POST') return reply({ error: 'unknown node telemetry route' }, 404);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (!token) return reply({ error: 'node telemetry request denied' }, 403);
  try {
    const context = { ownerId: match[1], nodeId: match[2] }, input = telemetryInput(match[4], await readBody(request));
    const authorization = await nodeFor(env, context).credentialTelemetry(context, 'observe', token[1], match[3]);
    // NodeMailbox 的事务/block 已经完全返回；指标 RPC 不能占用执行通道。
    return reply(await telemetryFor(env, authorizedTelemetry(authorization)).apply(authorization, match[4], input));
  } catch { return reply({ error: 'node telemetry denied or persistence uncertain' }, 409); }
}
export async function adminTelemetryRequest(request, env, session) {
  if (!telemetryEnabled(env) || env.ENABLE_CATALOG !== 'yes' || !env.REGISTRY) return reply({ error: 'node telemetry disabled' }, 503);
  const url = new URL(request.url), match = /^\/api\/admin\/nodes\/([a-f0-9-]{36})\/telemetry$/.exec(url.pathname);
  if (!match || !isUuid(match[1]) || request.method !== 'GET') return reply({ error: 'unknown node telemetry route' }, 404);
  if (url.search) return reply({ error: 'node telemetry query denied' }, 403);
  try {
    const context = { ownerId: session.actor, nodeId: match[1] };
    const catalog = await env.REGISTRY.get(env.REGISTRY.idFromName(`catalog/v1/${session.actor}`)).snapshot(session.actor);
    if (!catalog.servers.some(server => server.id === context.nodeId && ['enrolling', 'active'].includes(server.state))) throw new Error('unavailable node reference');
    const authorization = await nodeFor(env, context).adminTelemetryContext(context);
    if (authorization === null) return reply(telemetrySnapshot(context, null, Date.now(), false));
    return reply(await telemetryFor(env, authorizedTelemetry(authorization)).snapshot(authorizedTelemetry(authorization)));
  } catch { return reply({ error: 'node telemetry unknown or persistence uncertain' }, 409); }
}
