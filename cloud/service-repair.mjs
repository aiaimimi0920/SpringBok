import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { serviceEntries } from './service-instance.mjs';
import { exactSba, requireSba, canonicalSba, sbaDigest, sbaRequest, connectedSbaPolicy } from './sba-control.mjs';
import { recoverSbaReceipt } from '../src/sba/artifact.mjs';
import { compareVersions } from '../src/sba/contract.mjs';

export const repairEnabled = env => env.ENABLE_SERVICE_REPAIR === 'yes';
export const repairableJob = (plan, job) => !plan.previewOf && !plan.verificationOf &&
  ['deploy', 'update', 'repair'].includes(job?.request.action) && ['unknown', 'failed'].includes(job?.status) &&
  job.result?.status === job.status && typeof job.result.errorCode === 'string' && !!job.permitId && Number.isSafeInteger(job.runId);

export async function serviceRepairDraft(vault, owner, input) {
  exactSba(input, ['action', 'instanceId', 'previousTaskId', 'sourceSha', 'repairId']);
  requireSba(repairEnabled(vault.env) && input.action === 'repair');
  connectedTaskId(input.instanceId); connectedTaskId(input.previousTaskId);
  const entries = serviceEntries(await vault.deploymentIndex(owner), input.instanceId);
  requireSba(entries.length && entries[0].taskId === input.previousTaskId);
  const parent = connectedStub(vault.env, input.previousTaskId), { plan: old } = await parent.bootstrap(owner), job = await parent.inspect(owner);
  requireSba((old.operation?.instanceId ?? input.previousTaskId) === input.instanceId && repairableJob(old, job));
  // 重新读取已完成的执行及固定 artifact；超时标记本身不能授权修复。
  const proof = await recoverSbaReceipt(old.policy.github, job, { token: vault.env.SBA_GITHUB_TOKEN });
  requireSba(proof.status === 'verified-receipt' && canonicalSba(proof.envelope.result) === canonicalSba(job.result));
  for (const reference of Object.values(old.connections)) vault.activeConnection(reference.id, reference.revision);
  const application = await vault.deploymentDraft(owner, { action: 'application', github: old.connections.github,
    repository: old.application.repository, sourceSha: input.sourceSha });
  requireSba(application.manifest.schemaVersion === 3 && application.manifest.id === old.application.manifest.id &&
    application.repository === old.application.repository && compareVersions(application.manifest.version, job.request.applicationVersion) > 0 &&
    input.sourceSha !== job.request.sourceSha && canonicalSba(application.declaration) === canonicalSba(old.application.declaration));
  const repair = application.manifest.repairs?.find(row => row.id === input.repairId);
  requireSba(repair && repair.fromErrorCodes.includes(job.result.errorCode));
  const context = { repairId: repair.id, parentTaskId: input.previousTaskId, parentRunId: job.runId,
    requestDigest: job.requestDigest, resultDigest: await sbaDigest(job.result), errorCode: job.result.errorCode };
  const operation = { action: 'repair', instanceId: input.instanceId, previousTaskId: input.previousTaskId,
    previous: { sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion }, previousResultDigest: context.resultDigest, context };
  const base = connectedSbaPolicy(vault.env), credentials = {};
  for (const name of application.manifest.secrets) {
    const mapping = old.credentials?.[name] ?? (name === 'CLOUDFLARE_API_TOKEN' ? 'cloudflare' : null);
    if (!repair.secretNames.includes(name)) credentials[name] = 'repair-disabled';
    else { requireSba(typeof mapping === 'string' && !mapping.startsWith('bootstrap') && !!old.connections[mapping]); credentials[name] = mapping; }
  }
  const policy = { ...old.policy, sourceSha: input.sourceSha, secretNames: application.manifest.secrets,
    github: { ...base.github, applicationRepository: old.application.repository } };
  const plan = { ...old, application, policy, operation, credentials };
  sbaRequest(policy, 'dc-' + '0'.repeat(32), application.manifest, operation);
  return { ...plan, digest: await sbaDigest({ ...plan, digest: null }) };
}
