import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
const sets = new Map();
const encode = value => new TextEncoder().encode(value);
const hex = value => [...new Uint8Array(value)].map(b => b.toString(16).padStart(2, '0')).join('');
export function sameProof(value, expected) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && crypto.subtle.timingSafeEqual(encode(value), encode(expected));
}
export async function signSession(session, purpose, value) {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encode(session.token)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encode(JSON.stringify([purpose, session.origin, session.actor, value]))));
}
export async function accessSession(request, env) {
  const origin = env.ADMIN_ORIGIN, issuer = env.ACCESS_ISSUER, audience = env.ACCESS_AUD;
  if (typeof origin !== 'string' || new URL(origin).origin !== origin || !origin.startsWith('https://') || typeof issuer !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) || typeof audience !== 'string' || !/^[a-f0-9]{64}$/.test(audience)) throw new Error('admin disabled');
  const allowed = JSON.parse(env.ADMIN_EMAILS ?? '[]');
  if (!Array.isArray(allowed) || allowed.length !== 1 || typeof allowed[0] !== 'string' || allowed[0] !== allowed[0].trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowed[0])) throw new Error('admin disabled');
  const url = new URL(request.url);
  const navigation = request.method === 'GET' && url.pathname === '/'; // Safe page entry from an external link; identity is still required.
  if (url.origin !== origin || url.search || (request.headers.has('origin') && request.headers.get('origin') !== origin) || (!navigation && request.headers.has('sec-fetch-site') && !['same-origin', 'none'].includes(request.headers.get('sec-fetch-site')))) throw new Error('admin request denied');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (typeof token !== 'string' || token.length > 8192) throw new Error('admin identity required');
  const certs = `${issuer}/cdn-cgi/access/certs`;
  if (!sets.has(issuer)) {
    if (sets.size >= 4) sets.clear();
    sets.set(issuer, createRemoteJWKSet(new URL(certs), { timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 300000,
      [customFetch]: async (url, options) => {
        if (String(url) !== certs) throw new Error('untrusted key source');
        const response = await fetch(certs, { ...options, redirect: 'manual', signal: AbortSignal.timeout(3000) });
        if (!response.ok) { await response.body?.cancel(); throw new Error('identity keys unavailable'); }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw new Error('large key response'); chunks.push(value); } }
        finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }));
  }
  const { payload } = await jwtVerify(token, sets.get(issuer), { algorithms: ['RS256'], issuer, audience, requiredClaims: ['sub', 'email', 'iat', 'exp', 'iss', 'aud'], clockTolerance: 5, maxTokenAge: '24h' });
  const now = Math.floor(Date.now() / 1000);
  if (payload.type !== 'app' || typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 128 || typeof payload.email !== 'string' || payload.email.toLowerCase() !== allowed[0] || payload.iat > now + 5 || payload.exp <= payload.iat || payload.exp - payload.iat > 86400) throw new Error('admin not permitted');
  return { token, origin, email: payload.email, actor: hex(await crypto.subtle.digest('SHA-256', encode(JSON.stringify([issuer, payload.sub])))) };
}
