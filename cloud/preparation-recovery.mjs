import { connectedEnabled, executeReserved } from './connected-api.mjs';
import { accountStub, connectedStub, connectedTaskId } from './connected-store.mjs';
import { canonicalSba, connectedSbaPolicy, exactSba, requireSba, sbaDigest, sbaPolicy, sbaRequest } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';
import { deploymentIdentities, legacyIdentities } from './deployment-ownership.mjs';
import { openToken } from './connections-crypto.mjs';
import { applicationRepository, readApplication } from './service-catalog.mjs';
import { serviceEntries } from './service-instance.mjs';

export function recoverableFirstPreparation(record) {
  const preparation = record?.preparation, plan = preparation?.intent;
  return preparation?.phase === 'reserved' && !preparation.recovery &&
    Object.keys(preparation.resources ?? {}).length === 0 && plan?.application?.declaration?.schemaVersion === 2 &&
    !plan.operation && !plan.previewOf && !plan.verificationOf && record.accountIds?.length === 1 &&
    Object.keys(plan.resources).length > 0 && Object.values(plan.resources).every(row => row.provision && row.remoteId === null) &&
    !Object.values(plan.credentials ?? {}).some(value => value.startsWith('bootstrap:'));
}

export function recoverableUpdatePreparation(record) {
  const service = record?.service;
  return !record?.preparation && !record?.recovery && service?.action === 'update' && !service.previewOf &&
    typeof service.id === 'string' && typeof service.parentTaskId === 'string' &&
    service.id !== record.taskId && service.parentTaskId !== record.taskId &&
    typeof record.accountId === 'string' && /^[a-f0-9]{32}$/.test(record.accountId) &&
    (!record.accountIds || (record.accountIds.length === 1 && record.accountIds[0] === record.accountId)) &&
    !Object.values(record.credentials ?? {}).some(value => value.startsWith('bootstrap:'));
}

export const recoverablePreparation = record => recoverableFirstPreparation(record) || recoverableUpdatePreparation(record);

function resolveReservedApplicationSecrets(vault, record, application, priorPlan) {
  const names = application.declaration.applicationSecrets ?? [];
  if (!names.length) return null;
  if (record.applicationSecrets) return structuredClone(record.applicationSecrets);
  const sql = vault.ctx.storage.sql;
  if (sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='application_task_secrets'").toArray().length) {
    const saved = sql.exec('SELECT metadata FROM application_task_secrets WHERE task=? AND name=?', record.taskId, names[0]).toArray()[0];
    if (saved) {
      const profileId = JSON.parse(saved.metadata).id.split(':')[0];
      const profileRow = sql.exec('SELECT metadata FROM application_secrets WHERE id=?', profileId).toArray()[0];
      requireSba(profileRow);
      const profile = JSON.parse(profileRow.metadata);
      requireSba(profile.active);
      return { id: profile.id, revision: profile.revision };
    }
  }
  requireSba(priorPlan?.applicationSecrets);
  return structuredClone(priorPlan.applicationSecrets);
}

export async function inspectPreparationRecovery(vault, owner, taskId) {
  connectedTaskId(taskId);
  const record = vault.ctx.storage.transactionSync(() => {
    vault.deploymentGuard(owner);
    const row = vault.ctx.storage.sql.exec('SELECT record FROM connection_deployments WHERE task=?', taskId).toArray()[0];
    requireSba(row);
    const parsed = JSON.parse(row.record);
    requireSba(recoverablePreparation(parsed));
    for (const ref of Object.values(parsed.connections)) vault.activeConnection(ref.id, ref.revision);
    return parsed;
  });
  if (recoverableFirstPreparation(record)) return { record, plan: record.preparation.intent };
  const entries = serviceEntries(vault.deploymentIndex(owner), record.service.id);
  requireSba(entries[0]?.taskId === taskId && entries[1]?.taskId === record.service.parentTaskId);
  const github = vault.activeConnection(record.connections.github.id, record.connections.github.revision);
  requireSba(github.row.provider === 'github');
  const repository = applicationRepository(github.row, record.service.application.repository);
  const token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, github.row, github.sealed);
  const application = await readApplication(vault.env, repository, record.service.application.sourceSha, token);
  const parent = connectedStub(vault.env, record.service.parentTaskId);
  const { plan: old } = await parent.bootstrap(owner), parentJob = await parent.inspect(owner);
  requireSba(parentJob && ['succeeded', 'deployed-unverified'].includes(parentJob.status) && parentJob.result?.status === parentJob.status);
  requireSba(!old.previewOf && (old.operation?.instanceId ?? record.service.parentTaskId) === record.service.id);
  const automatic = application.declaration.schemaVersion === 2;
  const base = connectedSbaPolicy(vault.env, application.manifest.runtime);
  const configuration = structuredClone(old.configuration);
  const policy = { ...base, github: { ...base.github, applicationRepository: repository },
    sourceSha: record.service.application.sourceSha, environment: record.service.environment,
    configuration, secretNames: application.manifest.secrets };
  sbaPolicy({ ...vault.env, SBA_POLICY: JSON.stringify(policy) });
  const connections = structuredClone(record.connections), resources = structuredClone(record.service.resources);
  const operation = { action: 'update', instanceId: record.service.id, previousTaskId: record.service.parentTaskId,
    previous: { sourceSha: parentJob.request.sourceSha, applicationVersion: parentJob.request.applicationVersion },
    previousResultDigest: await sbaDigest(parentJob.result) };
  sbaRequest(policy, 'service-update-validation', application.manifest, operation);
  const applicationSecrets = vault.ctx.storage.transactionSync(() => {
    for (const ref of Object.values(record.connections)) vault.activeConnection(ref.id, ref.revision);
    return resolveReservedApplicationSecrets(vault, record, application, old);
  });
  const basePlan = { application, policy, connections, resources, configuration,
    ...(automatic ? { accounts: structuredClone(record.service.accounts), credentials: structuredClone(record.credentials) } : {}),
    ...(applicationSecrets ? { applicationSecrets } : {}), operation };
  const digest = await sbaDigest({ application, policy, connections: basePlan.connections, resources,
    ...(automatic ? { accounts: basePlan.accounts, credentials: basePlan.credentials } : {}),
    ...(basePlan.applicationSecrets ? { applicationSecrets: basePlan.applicationSecrets } : {}), operation });
  requireSba(digest === record.digest);
  return { record, plan: { ...basePlan, digest } };
}

// 只扩展原任务记录；旧控制面仍会拒绝 resuming/recovery，不可能将它误认为新任务重放。
export function beginPreparationRecovery(vault, owner, taskId, digest, recoveryId) {
  connectedTaskId(taskId);
  return vault.ctx.storage.transactionSync(() => {
    vault.deploymentGuard(owner);
    const sql = vault.ctx.storage.sql;
    const record = JSON.parse(sql.exec('SELECT record FROM connection_deployments WHERE task=?', taskId).one().record);
    requireSba(recoverablePreparation(record) && record.digest === digest);
    for (const ref of Object.values(record.connections)) vault.activeConnection(ref.id, ref.revision);
    if (recoverableFirstPreparation(record)) {
      requireSba(record.preparation.intent.digest === digest);
      record.preparation.phase = 'resuming';
      record.preparation.recovery = { id: recoveryId, startedAt: Date.now() };
    } else {
      const entries = serviceEntries(sql.exec('SELECT record FROM connection_deployments ORDER BY rowid DESC').toArray().map(r => JSON.parse(r.record)), record.service.id);
      requireSba(entries[0]?.taskId === taskId && entries[1]?.taskId === record.service.parentTaskId);
      record.recovery = { id: recoveryId, startedAt: Date.now() };
    }
    sql.exec('UPDATE connection_deployments SET record=? WHERE task=?', JSON.stringify(record), taskId);
    return record;
  });
}

export async function preparationRecoveryRequest(env, vault, session, action, input) {
  requireSba(connectedEnabled(env));
  exactSba(input, action === 'resume-plan' ? ['taskId'] : ['taskId', 'digest', 'expiresAt', 'confirmation']);
  connectedTaskId(input.taskId);
  requireSba(await connectedStub(env, input.taskId).uninitialized());
  const { record, plan } = await vault.inspectPreparationRecovery(session.actor, input.taskId);
  const current = connectedSbaPolicy(env, plan.application.manifest.runtime);
  // 固定应用、配置和执行器；控制面配置漂移不能偷偷改变已确认任务。
  requireSba(record.digest === plan.digest && canonicalSba({ ...plan.policy.github, applicationRepository: current.github.applicationRepository }) === canonicalSba(current.github) && plan.policy.runnerOrigin === current.runnerOrigin);
  const legacy = legacyIdentities(sbaPolicy(env).configuration);
  requireSba(deploymentIdentities(plan).every(value => !legacy.includes(value)));
  if (action === 'resume-plan') {
    const accountIds = record.accountIds ?? [record.accountId];
    for (const id of accountIds) await accountStub(env, id).assertUnclaimedAndLaneFree(input.taskId);
    const expiresAt = Date.now() + 120000;
    return { taskId: input.taskId, digest: record.digest, expiresAt,
      confirmation: await signSession(session, 'preparation-confirm', [input.taskId, record.digest, expiresAt]), instance: record.service };
  }
  requireSba(input.digest === record.digest && Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000 &&
    sameProof(input.confirmation, await signSession(session, 'preparation-confirm', [input.taskId, input.digest, input.expiresAt])));
  const recoveryId = crypto.randomUUID();
  const reserved = await vault.beginPreparationRecovery(session.actor, input.taskId, input.digest, recoveryId);
  return executeReserved(env, session.actor, input.taskId, plan, reserved, recoveryId);
}
