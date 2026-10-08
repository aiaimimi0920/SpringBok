import { validateManifest, validateRequest } from '../src/sba/contract.mjs';
import { createGithubExecutor } from '../src/sba/github.mjs';
export const requireSba = value => { if (!value) throw new Error('SBA_REJECTED'); };
export const exactSba = (value, keys) => requireSba(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
export const canonicalSba = value => JSON.stringify(ordered(value));
export async function sbaDigest(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalSba(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function sbaPolicy(env) {
  requireSba(env.ENABLE_SBA === 'yes' && env.SBA_TASKS && typeof env.SBA_GITHUB_TOKEN === 'string' && env.SBA_GITHUB_TOKEN.length > 0);
  const p = JSON.parse(env.SBA_POLICY ?? 'null');
  exactSba(p, ['github', 'sourceSha', 'environment', 'configuration', 'secretNames', 'runnerOrigin']);
  exactSba(p.github, ['repository', 'repositoryId', 'applicationRepository', 'workflowId', 'workflowPath', 'ref', 'executorSha']);
  createGithubExecutor(p.github, { token: env.SBA_GITHUB_TOKEN });
  requireSba(p.github.ref === `sba-executor-${p.github.executorSha}` && p.github.workflowPath === '.github/workflows/sba-execute.yml');
  requireSba(typeof p.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(p.sourceSha) && typeof p.environment === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(p.environment));
  requireSba(p.configuration && typeof p.configuration === 'object' && !Array.isArray(p.configuration) && new TextEncoder().encode(canonicalSba(p.configuration)).length <= 32768);
  validateManifest({ schemaVersion: 2, id: 'policy-app', name: 'Policy', version: '1.0.0', entrypoint: 'entry.ps1',
    runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
    actions: { deploy: { timeoutSeconds: 3600 }, update: { timeoutSeconds: 3600 }, verify: { timeoutSeconds: 120 } }, secrets: p.secretNames });
  const origin = new URL(p.runnerOrigin);
  requireSba(origin.protocol === 'https:' && origin.origin === p.runnerOrigin && p.runnerOrigin !== env.ADMIN_ORIGIN && !origin.username && !origin.password);
  return p;
}
export function sbaEnabled(env) { try { sbaPolicy(env); return true; } catch { return false; } }
export function sbaRequest(policy, taskId, manifest, operation = null) {
  const app = validateManifest(manifest);
  requireSba(canonicalSba(app.secrets) === canonicalSba(policy.secretNames));
  if (operation !== null) requireSba(operation.action === 'update');
  return validateRequest({ schemaVersion: 2, taskId, action: operation?.action ?? 'deploy', repository: policy.github.applicationRepository,
    sourceSha: policy.sourceSha, applicationId: app.id, applicationVersion: app.version, environment: policy.environment,
    configuration: policy.configuration, previous: operation?.previous ?? null }, app);
}
export const sbaObjectName = p => `sba/v1/${p.github.applicationRepository}/${p.environment}`;
export const sbaStub = (env, p) => env.SBA_TASKS.get(env.SBA_TASKS.idFromName(sbaObjectName(p)));
export function sbaExecutorTransition(env, policy, executorSha) {
  requireSba(typeof executorSha === 'string' && /^[a-f0-9]{40}$/.test(executorSha) && executorSha !== policy.github.executorSha &&
    env.SBA_RECOVERY_EXECUTOR_SHA === executorSha);
  const next = structuredClone(policy);
  next.github.executorSha = executorSha; next.github.ref = `sba-executor-${executorSha}`;
  return sbaPolicy({ ...env, SBA_POLICY: JSON.stringify(next) });
}
export function sbaRecoveryApproval(value) {
  exactSba(value, ['taskId', 'runId', 'requestDigest', 'resultDigest', 'oldPolicyDigest', 'executorSha', 'sourceSha', 'evidenceDigest', 'approvedAt', 'expiresAt']);
  requireSba(typeof value.taskId === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(value.taskId) && Number.isSafeInteger(value.runId) && value.runId > 0);
  for (const key of ['requestDigest', 'resultDigest', 'oldPolicyDigest', 'evidenceDigest']) requireSba(typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]));
  for (const key of ['executorSha', 'sourceSha']) requireSba(typeof value[key] === 'string' && /^[a-f0-9]{40}$/.test(value[key]));
  requireSba(Number.isSafeInteger(value.approvedAt) && value.approvedAt > 0 && Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > value.approvedAt && value.expiresAt <= value.approvedAt + 3600000);
  return value;
}
export function sbaRecoveryNextPolicy(env, policy, approval) {
  sbaRecoveryApproval(approval);
  requireSba(approval.executorSha !== policy.github.executorSha && approval.sourceSha !== policy.sourceSha);
  const next = structuredClone(policy);
  next.github.executorSha = approval.executorSha; next.github.ref = `sba-executor-${approval.executorSha}`;
  next.sourceSha = approval.sourceSha;
  return sbaPolicy({ ...env, SBA_POLICY: JSON.stringify(next) });
}
export async function sbaAuthorizedRecovery(env, policy) {
  requireSba(typeof env.SBA_OPERATOR_RECOVERY === 'string' && env.SBA_OPERATOR_RECOVERY.length <= 4096);
  const approval = sbaRecoveryApproval(JSON.parse(env.SBA_OPERATOR_RECOVERY));
  requireSba(approval.approvedAt <= Date.now() && approval.expiresAt > Date.now() && approval.oldPolicyDigest === await sbaDigest(policy));
  return { approval, nextPolicy: sbaRecoveryNextPolicy(env, policy, approval) };
}
export function sbaSummary(job) {
  if (!job) return { mode: 'sba-first-deployment', ready: true, job: null };
  const { request, status, runId, submittedAt, permitAt, result, errorCode } = job;
  return { mode: 'sba-first-deployment', ready: false, job: { request, status, runId, submittedAt, permitAt, result, errorCode } };
}
