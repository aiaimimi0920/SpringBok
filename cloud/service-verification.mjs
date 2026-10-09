import { connectedStub } from './connected-store.mjs';
import { connectedState } from './connected-api.mjs';
import { serviceEntries } from './service-instance.mjs';
import { exactSba, requireSba, sbaRequest } from './sba-control.mjs';
import { createGithubExecutor } from '../src/sba/github.mjs';

export const canVerifyService = (plan, job) => !plan.verificationOf && !plan.previewOf &&
  ['deploy', 'update'].includes(job?.request.action) && !!job.result &&
  ['unknown', 'failed', 'succeeded', 'deployed-unverified'].includes(job.status);

export async function verificationState(env, owner, parent, reconcile) {
  const reference = await connectedStub(env, parent).verification(owner);
  if (!reference) return null;
  try {
    const state = await connectedState(env, owner, reference.taskId, reconcile);
    return { ...reference, status: state.job?.status ?? state.status, job: state.job, runUrl: state.runUrl };
  } catch {
    // Reservation precedes the single dispatch authority. Never replay a lost
    // dispatch or mistake missing evidence for successful availability.
    return { ...reference, status: 'unknown', errorCode: 'VERIFICATION_PREPARATION_UNCONFIRMED' };
  }
}

export async function startServiceVerification(env, vault, owner, input) {
  exactSba(input, ['instanceId', 'previousTaskId']);
  requireSba(!await vault.deletionRecord(owner,input.instanceId));
  const entries = serviceEntries(await vault.deploymentIndex(owner), input.instanceId);
  requireSba(entries.length && entries[0].taskId === input.previousTaskId);
  const parent = connectedStub(env, input.previousTaskId), { plan } = await parent.bootstrap(owner), job = await parent.inspect(owner);
  requireSba(canVerifyService(plan, job));
  const reservation = await parent.reserveVerification(owner);
  if (!reservation.dispatch) return verificationState(env, owner, input.previousTaskId, true);
  const operation = { action: 'verify', instanceId: input.instanceId, previousTaskId: input.previousTaskId,
    previous: { sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion } };
  const verificationPlan = { ...plan, operation, verificationOf: input.previousTaskId };
  const request = sbaRequest(plan.policy, reservation.taskId, plan.application.manifest, operation);
  const child = connectedStub(env, reservation.taskId);
  await child.initialize(owner, reservation.taskId, verificationPlan);
  const claim = await child.begin(owner, { request, manifest: plan.application.manifest });
  if (claim.dispatch) {
    const executor = createGithubExecutor(plan.policy.github, { token: env.SBA_GITHUB_TOKEN });
    await child.attachRun(owner, reservation.taskId, await executor.dispatch(request, plan.application.manifest));
  }
  return verificationState(env, owner, input.previousTaskId, false);
}
