import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
export const origin = 'https://admin.example.invalid';
export const issuer = 'https://synthetic-team.cloudflareaccess.com';
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = (await build({ entryPoints: [join(root, 'cloud/worker.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })).outputFiles[0].text;
export async function adminFixture(overrides = {}, { entryPoint, telemetry = false, sba = false, connections = false, outbound } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-admin-'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  const bindings = { ENABLE_ADMIN: 'yes', ADMIN_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: '1'.repeat(64), ADMIN_EMAILS: '["owner@example.invalid"]', ENABLE_PROTOCOL_TEST: 'yes', ENABLE_FIXTURE_CYCLE: 'yes', FIXTURE_BINDING: '2'.repeat(64), NODE_TOKEN: randomBytes(32).toString('hex'), CONTROL_TOKEN: randomBytes(32).toString('hex'), ...overrides };
  const fixture = { bindings, outage: false, keyCalls: 0, mf: null };
  const script = entryPoint ? (await build({ entryPoints: [join(root, entryPoint)], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })).outputFiles[0].text : bundle;
  const options = { name: 'springbok-admin-test', modules: true, script, compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0,
    durableObjects: { ...(connections ? { CONNECTIONS: { className: 'ConnectionVault', useSQLite: true } } : {}), TARGET: { className: 'TargetMailbox', useSQLite: true }, REGISTRY: { className: 'OwnerCatalog', useSQLite: true }, NODES: { className: 'NodeMailbox', useSQLite: true }, ...(sba ? { SBA_TASKS: { className: 'SbaDeployment', useSQLite: true } } : {}), ...(telemetry ? { TELEMETRY: { className: 'NodeTelemetry', useSQLite: true } } : {}) }, resourcePersistencePath: join(directory, 'state'),
    assets: { routerConfig: { has_user_worker: true }, directory: join(root, 'public/cloud-admin'), binding: 'ASSETS', run_worker_first: true }, telemetry: { enabled: false }, cf: false, logRequests: false, bindings,
    outboundService: async request => {
      fixture.keyCalls++;
      if (request.url !== `${issuer}/cdn-cgi/access/certs`) return outbound ? outbound(request, { jwk, fixture }) : new Response(null, { status: 503 });
      if (fixture.outage) return new Response(null, { status: 503 });
      return Response.json({ keys: [jwk] });
    } };
  fixture.jwt = (claims = {}, header = {}) => {
    const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid: 'synthetic-key', typ: 'JWT', ...header })}.${encode({ iss: issuer, aud: [bindings.ACCESS_AUD], sub: 'owner-subject', email: 'owner@example.invalid', type: 'app', iat: now, exp: now + 3600, ...claims })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
  };
  fixture.restart = async () => { await fixture.mf?.dispose(); fixture.mf = new Miniflare(convertV4MiniflareOptions(options)); await fixture.mf.ready; };
  fixture.call = async (path, { token = fixture.jwt(), body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fixture.mf.dispatchFetch(origin + path, { method, headers: { ...(token === null ? {} : { 'cf-access-jwt-assertion': token }), ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
  };
  fixture.close = async () => { await fixture.mf?.dispose(); rmSync(directory, { recursive: true, force: true }); };
  await fixture.restart(); return fixture;
}
