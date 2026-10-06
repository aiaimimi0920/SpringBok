import { accessSession, signSession, sameProof } from './access.mjs';
import { adminSbaRequest } from './sba-api.mjs';
import { sbaEnabled } from './sba-control.mjs';
import { exact, NODE, submission } from './protocol.mjs';
import { adminEnrollmentRequest, enrollmentEnabled } from './enrollment-api.mjs';
import { adminNodeProbeRequest } from './node-channel-api.mjs';
import { adminHeartbeatRequest, heartbeatEnabled } from './heartbeat-api.mjs';
import { adminTelemetryRequest, telemetryEnabled } from './telemetry-api.mjs';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'content-type': 'application/json' } });
export async function adminRequest(request, env, readBody) {
  try {
    const session = await accessSession(request, env), url = new URL(request.url);
    if (request.method === 'GET' && ['/', '/app.js', '/sba.js', '/catalog.js', '/enrollment.js', '/telemetry.js', '/disk-contract.mjs', '/network-contract.mjs', '/style.css'].includes(url.pathname)) {
      const response = await env.ASSETS.fetch(request);
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    }
    if (url.pathname.startsWith('/api/admin/sba/')) return adminSbaRequest(request, env, session, readBody);
    const catalogEnabled = env.ENABLE_CATALOG === 'yes' && !!env.REGISTRY;
    if (url.pathname.startsWith('/api/admin/enrollments')) return adminEnrollmentRequest(request, env, session, readBody);
    if (/^\/api\/admin\/nodes\/[^/]+\/heartbeat$/.test(url.pathname)) return adminHeartbeatRequest(request, env, session);
    if (/^\/api\/admin\/nodes\/[^/]+\/telemetry$/.test(url.pathname)) return adminTelemetryRequest(request, env, session);
    if (url.pathname.startsWith('/api/admin/nodes/')) return adminNodeProbeRequest(request, env, session, readBody);
    if (['/api/admin/servers', '/api/admin/services'].includes(url.pathname)) {
      if (!catalogEnabled) return reply({ error: 'server catalog disabled' }, 503);
      if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'unknown catalog route' }, 404);
      if (request.method === 'POST' && (request.headers.get('origin') !== session.origin || !sameProof(request.headers.get('x-csrf-token'), await signSession(session, 'csrf', null)))) return reply({ error: 'refresh this authenticated session' }, 403);
      const catalog = env.REGISTRY.get(env.REGISTRY.idFromName(`catalog/v1/${session.actor}`));
      const service = url.pathname === '/api/admin/services';
      try { return reply(request.method === 'GET' ? await catalog[service ? 'serviceSnapshot' : 'snapshot'](session.actor) : await catalog[service ? 'mutateService' : 'mutate'](session.actor, await readBody(request))); }
      catch { return reply({ error: 'catalog rejected, stale or persistence uncertain; refresh before retrying' }, 409); }
    }
    const stub = env.TARGET.get(env.TARGET.idFromName(NODE));
    if (request.method === 'GET' && url.pathname === '/api/admin/state') {
      return reply({ ...await stub.admin('state', null, session.actor), email: session.email, csrf: await signSession(session, 'csrf', null), catalogEnabled, enrollmentEnabled: enrollmentEnabled(env), heartbeatEnabled: heartbeatEnabled(env), telemetryEnabled: telemetryEnabled(env), sbaEnabled: sbaEnabled(env), ownerId: session.actor });
    }
    if (request.method !== 'POST' || !['/api/admin/preview', '/api/admin/submit'].includes(url.pathname)) return reply({ error: 'unknown admin route' }, 404);
    if (request.headers.get('origin') !== session.origin || !sameProof(request.headers.get('x-csrf-token'), await signSession(session, 'csrf', null))) return reply({ error: 'refresh this authenticated session' }, 403);
    const value = await readBody(request);
    if (url.pathname === '/api/admin/preview') {
      exact(value, ['id', 'revision']);
      const input = submission({ id: value.id, node: NODE, operation: 'fixture-cycle', challenge: env.FIXTURE_BINDING, revision: value.revision });
      await stub.admin('preview', input, session.actor);
      const expiresAt = Date.now() + 120000;
      return reply({ input, expiresAt, confirmation: await signSession(session, 'confirm', [input, expiresAt]) });
    }
    exact(value, ['input', 'expiresAt', 'confirmation']); const input = submission(value.input);
    if (input.operation !== 'fixture-cycle' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < Date.now() || value.expiresAt > Date.now() + 120000 || typeof value.confirmation !== 'string' || !sameProof(value.confirmation, await signSession(session, 'confirm', [input, value.expiresAt]))) return reply({ error: 'confirmation expired or changed' }, 409);
    return reply(await stub.admin('submit', input, session.actor));
  } catch { return reply({ error: 'admin access denied, stale plan or persistence uncertain' }, 403); }
}
