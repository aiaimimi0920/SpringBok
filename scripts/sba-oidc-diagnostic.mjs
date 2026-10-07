import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const reject = () => { throw new Error('SBA_OIDC_DIAGNOSTIC_REJECTED'); };
const fields = ['event_name', 'runner_environment', 'run_attempt', 'environment', 'job_workflow_ref', 'job_workflow_sha', 'head_ref', 'base_ref'];
export function oidcContextProjection(payload, self = {}) {
  const expected = { event_name: 'workflow_dispatch', runner_environment: 'github-hosted', run_attempt: '1' };
  return Object.fromEntries(fields.map(field => {
    const value = payload[field];
    return [field, { present: Object.hasOwn(payload, field), type: value === null ? 'null' :
      ['undefined', 'string', 'number', 'boolean'].includes(typeof value) ? typeof value : 'other',
      emptyString: value === '', matchesExpected: Object.hasOwn(expected, field) ? value === expected[field] :
        value === undefined || (['head_ref', 'base_ref'].includes(field) && value === ''),
      ...(['job_workflow_ref', 'job_workflow_sha'].includes(field) ? {
        matchesSelf: typeof self[field] === 'string' && value === self[field],
      } : {}) }];
  }));
}
export async function diagnoseOidc(environment = process.env) {
  const sha = environment.GITHUB_SHA, ref = environment.GITHUB_REF, repository = environment.GITHUB_REPOSITORY;
  if (environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment.GITHUB_RUN_ATTEMPT !== '1' ||
      !/^[a-f0-9]{40}$/.test(sha) || ref !== `refs/tags/sba-oidc-diagnostic-${sha}` ||
      environment.GITHUB_WORKFLOW_SHA !== sha || environment.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/sba-oidc-diagnostic.yml@${ref}`) reject();
  const origin = new URL(environment.SBA_RUNNER_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== environment.SBA_RUNNER_ORIGIN || origin.username || origin.password) reject();
  const audience = `${origin.origin}/sba/v2/permit`, url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.endsWith('.actions.githubusercontent.com') || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN) reject();
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (response.status !== 200 || !response.body) reject();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 32768) reject(); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const token = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))).value;
  if (typeof token !== 'string' || token.length > 16384) reject();
  const issuer = 'https://token.actions.githubusercontent.com';
  const { createRemoteJWKSet, jwtVerify } = await import('../cloud/node_modules/jose/dist/webapi/index.js');
  const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`)),
    { algorithms: ['RS256'], issuer, audience, maxTokenAge: '5m', clockTolerance: 5 });
  if (payload.repository !== repository || payload.repository_id !== environment.GITHUB_REPOSITORY_ID ||
      payload.sha !== sha || payload.workflow_sha !== sha || payload.ref !== ref ||
      payload.workflow_ref !== environment.GITHUB_WORKFLOW_REF || payload.run_id !== environment.GITHUB_RUN_ID) reject();
  // 此 run 只诊断自身 signed context；不访问 SpringBok、不读取应用、不领取许可或注入秘密。
  return { signatureVerified: true, exactRunIdentityVerified: true, context: oidcContextProjection(payload,
    { job_workflow_ref: environment.GITHUB_WORKFLOW_REF, job_workflow_sha: sha }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`SBA_OIDC_CONTEXT_PROOF ${JSON.stringify(await diagnoseOidc())}`); }
  catch { console.error('SBA_OIDC_DIAGNOSTIC_UNCONFIRMED'); process.exitCode = 1; }
}
