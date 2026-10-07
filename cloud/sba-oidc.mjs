import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

const issuer = 'https://token.actions.githubusercontent.com';
const certs = `${issuer}/.well-known/jwks`;
const reject = () => { throw new Error('SBA_OIDC_REJECTED'); };

// 仅校验执行身份；任务摘要和 GitHub run 元数据仍须由 permit API 独立绑定。
export function createSbaOidcVerifier({ fetchImpl = fetch } = {}) {
  const keys = createRemoteJWKSet(new URL(certs), {
    timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 300000,
    [customFetch]: async (url, options) => {
      if (String(url) !== certs) reject();
      const response = await fetchImpl(certs, { ...options, redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); reject(); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 65536) reject(); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    },
  });
  return async (token, policy, { onReject = () => {} } = {}) => {
    let reason = 'token';
    try {
      if (typeof token !== 'string' || token.length < 1 || token.length > 16384) reject();
      const audience = `${policy.runnerOrigin}/sba/v2/permit`; reason = 'jwt';
      const { payload: p } = await jwtVerify(token, keys, { algorithms: ['RS256'], issuer, audience,
        requiredClaims: ['sub', 'jti', 'iat', 'nbf', 'exp', 'iss', 'aud'], maxTokenAge: '5m', clockTolerance: 5 });
      const now = Math.floor(Date.now() / 1000), g = policy.github, ref = `refs/tags/${g.ref}`;
      const [owner, repository] = g.repository.split('/');
      const subjects = [`repo:${g.repository}:ref:${ref}`];
      if (p.repository_owner === owner && typeof p.repository_owner_id === 'string' && /^[1-9][0-9]*$/.test(p.repository_owner_id))
        subjects.push(`repo:${owner}@${p.repository_owner_id}/${repository}@${g.repositoryId}:ref:${ref}`);
      reason = 'subject';
      if (p.aud !== audience || !subjects.includes(p.sub) || typeof p.jti !== 'string' || !p.jti) reject();
      reason = 'time';
      if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || !Number.isInteger(p.nbf) ||
          p.iat > now + 5 || p.exp <= p.iat || p.exp - p.iat > 600 || p.nbf > p.exp) reject();
      reason = 'repository'; if (p.repository !== g.repository || p.repository_id !== String(g.repositoryId)) reject();
      reason = 'executor';
      if (p.workflow_sha !== g.executorSha || p.sha !== g.executorSha || p.ref !== ref || p.ref_type !== 'tag' ||
          p.workflow_ref !== `${g.repository}/${g.workflowPath}@${ref}`) reject();
      reason = 'context';
      if (p.event_name !== 'workflow_dispatch' || p.runner_environment !== 'github-hosted' || p.run_attempt !== '1' ||
          p.environment !== undefined || p.job_workflow_ref !== undefined || p.job_workflow_sha !== undefined ||
          (p.head_ref !== undefined && p.head_ref !== '') || (p.base_ref !== undefined && p.base_ref !== '')) reject();
      reason = 'run-id';
      if (typeof p.run_id !== 'string' || !/^[1-9][0-9]*$/.test(p.run_id) || !Number.isSafeInteger(Number(p.run_id))) reject();
      return { runId: Number(p.run_id), runAttempt: 1, executorSha: g.executorSha };
    } catch { onReject(reason); reject(); }
  };
}
