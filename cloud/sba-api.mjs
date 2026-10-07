import { signSession, sameProof } from './access.mjs';
import { sbaPolicy, sbaStub, sbaRequest, sbaDigest, canonicalSba, exactSba, requireSba } from './sba-control.mjs';
import { createSbaOidcVerifier } from './sba-oidc.mjs';
import { createGithubExecutor } from '../src/sba/github.mjs';
import { recoverSbaReceipt } from '../src/sba/artifact.mjs';
import { githubSourcePack, SOURCE_CONTENT_TYPE } from '../src/sba/source.mjs';
const verifyOidc = createSbaOidcVerifier();
const reply = (value, status = 200) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
} });

export function isSbaMachineRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/sba/')) return true;
  try { return url.origin === JSON.parse(env.SBA_POLICY).runnerOrigin; } catch { return false; }
}

export async function sbaMachineRequest(request, env, readBody) {
  try {
    const policy = sbaPolicy(env), url = new URL(request.url);
    requireSba(url.origin === policy.runnerOrigin && ['/sba/v2/permit', '/sba/v2/source'].includes(url.pathname) && !url.search &&
      request.method === 'POST' && !request.headers.has('cookie') && !request.headers.has('origin'));
    const authorization = request.headers.get('authorization');
    requireSba(typeof authorization === 'string' && authorization.startsWith('Bearer '));
    const identity = await verifyOidc(authorization.slice(7), policy);
    const input = await readBody(request);
    exactSba(input, ['taskId', 'requestDigest']);
    requireSba(typeof input.taskId === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(input.taskId) &&
      typeof input.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(input.requestDigest));
    const stub = sbaStub(env, policy), job = await stub.pending(input.taskId, input.requestDigest);
    requireSba(job.permitId === null && ['dispatching', 'dispatched', 'dispatch-unknown'].includes(job.status) &&
      (job.runId === null || job.runId === identity.runId));
    const executor = createGithubExecutor(policy.github, { token: env.SBA_GITHUB_TOKEN });
    // OIDC 身份不包含 workflow inputs，必须另查 GitHub 的精确 task/digest run title。
    requireSba((await executor.inspectRun(identity.runId, job.request, job.manifest)).status === 'pending');
    if (url.pathname === '/sba/v2/source') {
      const bytes = await githubSourcePack(job.request.repository, job.request.sourceSha, env.SBA_GITHUB_TOKEN);
      return new Response(bytes, { headers: { 'content-type': SOURCE_CONTENT_TYPE, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
    }
    const available = JSON.parse(env.SBA_APPLICATION_SECRETS ?? '{}'), secrets = {};
    requireSba(available && typeof available === 'object' && !Array.isArray(available));
    for (const name of policy.secretNames) {
      requireSba(Object.hasOwn(available, name) && typeof available[name] === 'string' && available[name].length > 0 && available[name].length <= 16384);
      secrets[name] = available[name];
    }
    // 先消费后响应；响应丢失也不允许再次发放秘密。秘密不写入 DO 或 dispatch inputs。
    const permit = await stub.permit(input.taskId, input.requestDigest, identity.runId);
    return reply({ ...permit, secrets });
  } catch { return reply({ error: 'SBA_PERMIT_DENIED' }, 403); }
}

export async function adminSbaRequest(request, env, session, readBody) {
  try {
    const policy = sbaPolicy(env), stub = sbaStub(env, policy), url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/admin/sba/state') return reply(await stub.snapshot(session.actor));
    requireSba(request.method === 'POST' && ['/api/admin/sba/preview', '/api/admin/sba/submit', '/api/admin/sba/reconcile'].includes(url.pathname));
    requireSba(request.headers.get('origin') === session.origin &&
      sameProof(request.headers.get('x-csrf-token'), await signSession(session, 'csrf', null)));
    const input = await readBody(request, 65536);
    const executor = createGithubExecutor(policy.github, { token: env.SBA_GITHUB_TOKEN });
    if (url.pathname.endsWith('/preview')) {
      exactSba(input, ['taskId']);
      requireSba(typeof input.taskId === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(input.taskId));
      requireSba((await stub.snapshot(session.actor)).ready);
      const manifest = await executor.readManifest(policy.sourceSha);
      const plan = { request: sbaRequest(policy, input.taskId, manifest), manifest, policyDigest: await sbaDigest(policy) };
      const expiresAt = Date.now() + 120000;
      return reply({ plan, expiresAt, confirmation: await signSession(session, 'sba-confirm', [plan, expiresAt]) });
    }
    if (url.pathname.endsWith('/submit')) {
      exactSba(input, ['plan', 'expiresAt', 'confirmation']);
      exactSba(input.plan, ['request', 'manifest', 'policyDigest']);
      requireSba(Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000 &&
        input.plan.policyDigest === await sbaDigest(policy) &&
        sameProof(input.confirmation, await signSession(session, 'sba-confirm', [input.plan, input.expiresAt])));
      // 会话证明不是服务端秘密；持有 JWT 的管理员能重新签名，故必须重新核对可信源码。
      const trustedManifest = await executor.readManifest(policy.sourceSha);
      requireSba(canonicalSba(trustedManifest) === canonicalSba(input.plan.manifest));
      const claim = await stub.begin(session.actor, { request: input.plan.request, manifest: trustedManifest });
      if (!claim.dispatch) return reply(claim.snapshot);
      const outcome = await executor.dispatch(input.plan.request, input.plan.manifest);
      return reply(await stub.attachRun(session.actor, input.plan.request.taskId, outcome));
    }
    exactSba(input, ['taskId']);
    const job = await stub.inspect(session.actor);
    requireSba(job && job.request.taskId === input.taskId);
    if (job.status !== 'running') return reply(await stub.snapshot(session.actor));
    const outcome = await recoverSbaReceipt(policy.github, job, { token: env.SBA_GITHUB_TOKEN });
    if (outcome.status === 'verified-receipt') return reply(await stub.settle(session.actor, outcome.envelope));
    if (outcome.status === 'unknown') return reply(await stub.markUnknown(session.actor, input.taskId));
    return reply(await stub.snapshot(session.actor));
  } catch { return reply({ error: 'SBA_REQUEST_REJECTED_OR_UNCONFIRMED' }, 409); }
}
