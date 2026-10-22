import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
const sets = new Map();
const encode = value => new TextEncoder().encode(value);
const hex = value => [...new Uint8Array(value)].map(b => b.toString(16).padStart(2, '0')).join('');
export function sameProof(value, expected) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && crypto.subtle.timingSafeEqual(encode(value), encode(expected));
}
export async function signSession(session, purpose, value) {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encode(session.proofKey ?? session.token)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const context = [purpose, session.origin, session.actor, value];
  if (session.automation) context.push(['access-service-token', session.automation.clientId, session.automation.issuedAt, session.automation.expiresAt]);
  if (session.automation?.deployment) context.push(session.automation.deployment);
  return hex(await crypto.subtle.sign('HMAC', key, encode(JSON.stringify(context))));
}
export function automationRoute(method, pathname, automation = null) {
  if (automation?.deployment) return (method === 'GET' && pathname === '/api/admin/sba/session') ||
    (method === 'POST' && [...['plan', 'submit', 'state', 'reconcile', 'verify'], ...(automation.deployment.cancellation ? ['cancel-unstarted'] : [])].some(route => pathname === '/api/admin/deployments/' + route));
  return (method === 'GET' && ['/api/admin/sba/session', '/api/admin/sba/state'].includes(pathname)) ||
    (method === 'POST' && ['/api/admin/sba/preview', '/api/admin/sba/submit', '/api/admin/sba/reconcile', '/api/admin/sba/recover-unstarted', '/api/admin/sba/recover-authorized', '/api/admin/sba/import-preview', '/api/admin/sba/import-submit'].includes(pathname));
}
export async function accessSession(request, env) {
  const origin = env.ADMIN_ORIGIN, issuer = env.ACCESS_ISSUER, audience = env.ACCESS_AUD;
  if (typeof origin !== 'string' || new URL(origin).origin !== origin || !origin.startsWith('https://') || typeof issuer !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) || typeof audience !== 'string' || !/^[a-f0-9]{64}$/.test(audience)) throw new Error('admin disabled');
  const allowed = JSON.parse(env.ADMIN_EMAILS ?? '[]');
  if (!Array.isArray(allowed) || allowed.length !== 1 || typeof allowed[0] !== 'string' || allowed[0] !== allowed[0].trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowed[0])) throw new Error('admin disabled');
  const url = new URL(request.url);
  const navigation = request.method === 'GET' && ['/', '/services', '/history', '/settings', '/settings.html', '/deploy', '/deploy.html', '/resources', '/resources.html'].includes(url.pathname); // 允许登录回跳和外部链接进入页面；仍须验证 Access 身份，API 不豁免。
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
  const { payload } = await jwtVerify(token, sets.get(issuer), { algorithms: ['RS256'], issuer, audience, requiredClaims: ['sub', 'iat', 'exp', 'iss', 'aud'], clockTolerance: 5, maxTokenAge: '24h' });
  const now = Math.floor(Date.now() / 1000);
  if (payload.type !== 'app' || payload.iat > now + 5 || payload.exp <= payload.iat || payload.exp - payload.iat > 86400) throw new Error('admin not permitted');
  if (payload.sub === '') {
    // 这是明确限时的机器委托，不是邮箱登录，也不能降级为不验签的 API key。
    // Access 可转发冗余 Cookie；身份只取已验签的 assertion，Cookie 不参与认证。
    if (Object.hasOwn(payload, 'email') || typeof env.SBA_AUTOMATION_ACCESS !== 'string' || env.SBA_AUTOMATION_ACCESS.length > 2048 ||
      typeof env.SBA_AUTOMATION_PROOF_KEY !== 'string' || !/^[a-f0-9]{64}$/.test(env.SBA_AUTOMATION_PROOF_KEY)) throw new Error('automation not permitted');
    const a = JSON.parse(env.SBA_AUTOMATION_ACCESS), keys = ['clientId', 'ownerActor', 'issuedAt', 'expiresAt'];
    if (a && Object.hasOwn(a, 'deployment')) keys.push('deployment');
    const ms = Date.now();
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length !== keys.length || !keys.every(key => Object.hasOwn(a, key)) ||
      typeof a.clientId !== 'string' || !/^[a-f0-9]{32}\.access$/.test(a.clientId) || payload.common_name !== a.clientId ||
      typeof a.ownerActor !== 'string' || !/^[a-f0-9]{64}$/.test(a.ownerActor) || !Number.isSafeInteger(a.issuedAt) || a.issuedAt <= 0 ||
      !Number.isSafeInteger(a.expiresAt) || a.issuedAt > ms || a.expiresAt <= ms || a.expiresAt <= a.issuedAt || a.expiresAt > a.issuedAt + 86400000) throw new Error('automation not permitted');
    if (Object.hasOwn(a, 'deployment')) {
      const d = a.deployment, fields = ['instanceId', 'previousTaskId', 'repository', 'sourceSha'];
      if (d && Object.hasOwn(d, 'cancellation')) fields.push('cancellation');
      if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length !== fields.length || !fields.every(key => Object.hasOwn(d, key)) ||
        ![d.instanceId, d.previousTaskId].every(value => typeof value === 'string' && /^dc-[a-f0-9]{32}$/.test(value)) ||
        typeof d.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(d.repository) ||
        typeof d.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(d.sourceSha)) throw new Error('automation not permitted');
      if(Object.hasOwn(d,'cancellation')){
        const c=d.cancellation;
        if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).length!==2||
          !Object.hasOwn(c,'taskId')||!Object.hasOwn(c,'planDigest')||typeof c.taskId!=='string'||!/^dc-[a-f0-9]{32}$/.test(c.taskId)||
          [d.instanceId,d.previousTaskId].includes(c.taskId)||typeof c.planDigest!=='string'||!/^[a-f0-9]{64}$/.test(c.planDigest))throw new Error('automation not permitted');
      }
    }
    if (!automationRoute(request.method, url.pathname, a)) throw new Error('automation not permitted');
    return { token, origin, actor: a.ownerActor, automation: a, proofKey: env.SBA_AUTOMATION_PROOF_KEY };
  }
  if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 128 || typeof payload.email !== 'string' || payload.email.toLowerCase() !== allowed[0]) throw new Error('admin not permitted');
  return { token, origin, email: payload.email, actor: hex(await crypto.subtle.digest('SHA-256', encode(JSON.stringify([issuer, payload.sub])))) };
}
