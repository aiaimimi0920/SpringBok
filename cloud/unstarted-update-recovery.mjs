import { connectedEnabled, connectedState } from './connected-api.mjs';
import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { exactSba, requireSba } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';
import { createGithubExecutor } from '../src/sba/github.mjs';

export const canRestartUpdate = (plan, job) => plan.operation?.action === 'update' && !plan.previewOf && !plan.verificationOf &&
  ['dispatched', 'unknown'].includes(job?.status) && Number.isSafeInteger(job.runId) && job.runId > 0 &&
  job.permitAt === null && job.result === null;

export async function restartUpdateRequest(env, vault, session, action, input) {
  requireSba(connectedEnabled(env));
  exactSba(input, action === 'restart-plan' ? ['taskId'] : ['taskId', 'runId', 'digest', 'expiresAt', 'confirmation']);
  connectedTaskId(input.taskId);
  const index = await vault.deploymentIndex(session.actor), entry = index.find(row => row.taskId === input.taskId);
  requireSba(entry && index.find(row => row.service?.id === entry.service?.id)?.taskId === input.taskId);
  const stub = connectedStub(env, input.taskId), { plan } = await stub.bootstrap(session.actor), job = await stub.inspect(session.actor);
  requireSba(canRestartUpdate(plan, job) && job.permitId === null);
  requireSba((await stub.unstartedAttempts(session.actor)).length < 3);
  const executor = createGithubExecutor(plan.policy.github, { token: env.SBA_GITHUB_TOKEN });
  // 每次确认重新向 GitHub 核对精确 attempt=1 的终态，不能信任浏览器提交的证明。
  const proof = await executor.inspectUnstartedRun(job.runId, job.request, job.manifest);
  if (action === 'restart-plan') {
    const expiresAt = Date.now() + 120000;
    return { taskId: input.taskId, runId: job.runId, digest: job.requestDigest, expiresAt,
      confirmation: await signSession(session, 'update-restart', [input.taskId, job.runId, job.requestDigest, expiresAt]), instance: entry.service };
  }
  requireSba(input.runId === job.runId && input.digest === job.requestDigest && Number.isSafeInteger(input.expiresAt) &&
    input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000 &&
    sameProof(input.confirmation, await signSession(session, 'update-restart', [input.taskId, input.runId, input.digest, input.expiresAt])));
  const next = await stub.restartUnstarted(session.actor, proof);
  requireSba(next);
  const outcome = await executor.dispatch(next.request, next.manifest);
  await stub.attachRun(session.actor, input.taskId, outcome);
  return connectedState(env, session.actor, input.taskId);
}
