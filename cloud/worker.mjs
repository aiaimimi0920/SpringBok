import { DurableObject } from 'cloudflare:workers';
import { NODE, ledger, transition } from './protocol.mjs';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
async function equal(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const bytes = new TextEncoder(), [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', bytes.encode(a)), crypto.subtle.digest('SHA-256', bytes.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
async function body(request) {
  if (request.headers.get('content-type') !== 'application/json') throw new Error('invalid body');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2048)) throw new Error('large body');
  if (!request.body) throw new Error('missing body');
  const reader = request.body.getReader(); let size = 0; const chunks = [];
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2048) throw new Error('large body'); chunks.push(value); }
    if (timedOut) throw new Error('body deadline exceeded');
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); }
}
export default {
  async fetch(request, env) {
    if (env.ENABLE_PROTOCOL_TEST !== 'yes' || !validToken(env.CONTROL_TOKEN) || !validToken(env.NODE_TOKEN) || env.CONTROL_TOKEN === env.NODE_TOKEN) return json({ error: 'protocol test disabled' }, 503);
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.search || request.headers.has('cookie') || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return json({ error: 'request denied' }, 403);
    const routes = { '/control/state': ['GET', 'control', 'state'], '/control/submit': ['POST', 'control', 'submit'], '/node/poll': ['POST', 'node', 'poll'], '/node/report': ['POST', 'node', 'report'] };
    const route = routes[url.pathname]; if (!route || request.method !== route[0]) return json({ error: 'unknown route' }, 404);
    const authorization = request.headers.get('authorization');
    if (!await equal(authorization, `Bearer ${route[1] === 'control' ? env.CONTROL_TOKEN : env.NODE_TOKEN}`)) return json({ error: 'request denied' }, 403);
    try {
      const value = route[0] === 'POST' ? await body(request) : null;
      const stub = env.TARGET.get(env.TARGET.idFromName(NODE));
      return json(await stub.apply(route[2], value));
    } catch { return json({ error: 'request rejected or persistence uncertain' }, 409); }
  },
};
export class TargetMailbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mailbox (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
  }
  apply(operation, value) {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec('SELECT state FROM mailbox WHERE id=1').toArray();
      const state = rows.length ? ledger(JSON.parse(rows[0].state)) : { revision: 0, jobs: [] };
      if (operation === 'state') return { ...state, mode: 'protocol-test-only', deploymentVerified: false };
      const result = transition(state, operation, value, Date.now());
      if (result.changed) this.ctx.storage.sql.exec('INSERT INTO mailbox(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state', JSON.stringify(result.state));
      return result.response;
    });
  }
}
