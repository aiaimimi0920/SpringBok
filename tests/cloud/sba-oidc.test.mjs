import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from '../../cloud/node_modules/jose/dist/webapi/index.js';
import { createSbaOidcVerifier } from '../../cloud/sba-oidc.mjs';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const policy = { runnerOrigin: 'https://runner.example.com', github: { repository: 'owner/executor', repositoryId: 123,
  executorSha: 'a'.repeat(40), ref: `sba-executor-${'a'.repeat(40)}`, workflowPath: '.github/workflows/sba-execute.yml' } };
const ref = `refs/tags/${policy.github.ref}`;
function claims() {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://token.actions.githubusercontent.com', aud: `${policy.runnerOrigin}/sba/v2/permit`,
    sub: `repo:owner/executor:ref:${ref}`, jti: 'synthetic-jti', iat: now, nbf: now, exp: now + 300,
    repository: 'owner/executor', repository_id: '123', workflow_sha: 'a'.repeat(40), sha: 'a'.repeat(40),
    ref, ref_type: 'tag', workflow_ref: `owner/executor/.github/workflows/sba-execute.yml@${ref}`,
    event_name: 'workflow_dispatch', runner_environment: 'github-hosted', run_id: '456', run_attempt: '1' };
}
const sign = payload => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'synthetic' }).sign(privateKey);
const verifier = () => createSbaOidcVerifier({ fetchImpl: async (url, options) => {
  assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers?.authorization, undefined);
  return Response.json({ keys: [jwk] });
} });

test('exact synthetic GitHub execution identity is accepted', async () => {
  assert.deepEqual(await verifier()(await sign(claims()), policy), { runId: 456, runAttempt: 1, executorSha: 'a'.repeat(40) });
});
for (const [field, value] of Object.entries({ repository: 'other/executor', repository_id: '124', workflow_sha: 'b'.repeat(40),
  sha: 'b'.repeat(40), ref: 'refs/heads/main', ref_type: 'branch', workflow_ref: 'other/workflow', event_name: 'pull_request',
  runner_environment: 'self-hosted', run_id: '9007199254740993', run_attempt: '2', aud: 'https://other.example.com',
  environment: 'production', job_workflow_ref: 'reusable', job_workflow_sha: 'a'.repeat(40), head_ref: 'fork', base_ref: 'main',
  exp: 1, iat: Math.floor(Date.now() / 1000) + 1000, jti: '', sub: '' })) {
  test(`reject changed ${field}`, async () => {
    await assert.rejects(verifier()(await sign({ ...claims(), [field]: value }), policy), /SBA_OIDC_REJECTED/);
  });
}
test('reject invalid signature and oversized tokens', async () => {
  const verify = verifier(), { privateKey: other } = await generateKeyPair('RS256');
  const forged = await new SignJWT(claims()).setProtectedHeader({ alg: 'RS256', kid: 'synthetic' }).sign(other);
  await assert.rejects(verify(forged, policy), /SBA_OIDC_REJECTED/);
  await assert.rejects(verify('x'.repeat(16385), policy), /SBA_OIDC_REJECTED/);
});
test('fail closed on redirect, malformed and oversized key responses', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }),
    new Response('not-json'), new Response('x'.repeat(65537))]) {
    const verify = createSbaOidcVerifier({ fetchImpl: async () => response });
    await assert.rejects(verify(await sign(claims()), policy), /SBA_OIDC_REJECTED/);
  }
});

test('accept immutable subject only when signed owner and repository identities agree', async () => {
  const p = { ...claims(), repository_owner: 'owner', repository_owner_id: '789',
    sub: `repo:owner@789/executor@123:ref:${ref}` };
  assert.equal((await verifier()(await sign(p), policy)).runId, 456);
  for (const changed of [{ repository_owner: 'other' }, { repository_owner_id: '790' },
    { sub: `repo:owner@789/executor@124:ref:${ref}` }])
    await assert.rejects(verifier()(await sign({ ...p, ...changed }), policy), /SBA_OIDC_REJECTED/);
});

test('OIDC rejection exposes only fixed categories, not the signed claims or original error', async () => {
  const verify = verifier();
  for (const [changed, expected] of [[{ sub: 'synthetic-private-subject' }, 'subject'],
    [{ repository: 'synthetic-private-repo' }, 'repository'], [{ workflow_sha: 'b'.repeat(40) }, 'executor'],
    [{ run_attempt: '2' }, 'context'], [{ run_id: 'synthetic-private-run' }, 'run-id'],
    [{ exp: Math.floor(Date.now() / 1000) + 601 }, 'time']]) {
    let reason;
    await assert.rejects(verify(await sign({ ...claims(), ...changed }), policy, { onReject: value => { reason = value; } }), /SBA_OIDC_REJECTED/);
    assert.equal(reason, expected); assert.doesNotMatch(reason, /synthetic-private/);
  }
  let reason;
  await assert.rejects(verify('synthetic-private-invalid-token', policy, { onReject: value => { reason = value; } }), /SBA_OIDC_REJECTED/);
  assert.equal(reason, 'jwt');
});

test('accept current signed self-workflow job identity but reject foreign, partial and inconsistent pairs', async () => {
  const p = claims(), current = { ...p, job_workflow_ref: p.workflow_ref, job_workflow_sha: p.workflow_sha };
  assert.equal((await verifier()(await sign(current), policy)).runId, 456);
  for (const changed of [{ job_workflow_ref: 'other/workflow@refs/tags/foreign' },
    { job_workflow_sha: 'b'.repeat(40) }, { job_workflow_ref: undefined }, { job_workflow_sha: undefined },
    { job_workflow_ref: null, job_workflow_sha: null }, { job_workflow_ref: '', job_workflow_sha: '' }])
    await assert.rejects(verifier()(await sign({ ...current, ...changed }), policy), /SBA_OIDC_REJECTED/);
});
