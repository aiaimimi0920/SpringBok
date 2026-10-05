import { nodeMailboxName } from './node-protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { identityRequest } from './credential-contract.mjs';

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export async function nodeCredentialRequest(request, env, readBody) {
  if (env.ENABLE_NODE_MAILBOX !== 'yes' || env.ENABLE_NODE_CREDENTIALS !== 'yes' || !env.NODES) return reply({ error: 'node credentials disabled' }, 503);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.search || request.headers.has('cookie') || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return reply({ error: 'node identity request denied' }, 403);
  const match = /^\/node\/v2\/identity\/(execute|observe)\/([a-f0-9]{64})\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (!match || !isUuid(match[3]) || request.method !== 'POST') return reply({ error: 'unknown node identity route' }, 404);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (!token) return reply({ error: 'node identity request denied' }, 403);
  try {
    identityRequest(await readBody(request));
    const context = { ownerId: match[2], nodeId: match[3] }; // 仅寻址；节点当前持久绑定和角色摘要才是授权真相。
    const node = env.NODES.get(env.NODES.idFromName(nodeMailboxName(context)));
    return reply(await node.credentialIdentity(context, match[1], token[1]));
  } catch { return reply({ error: 'node identity denied or unconfirmed' }, 409); }
}
