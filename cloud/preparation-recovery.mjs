import { connectedEnabled, executeReserved } from './connected-api.mjs';
import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { canonicalSba, connectedSbaPolicy, exactSba, requireSba, sbaPolicy } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';
import { deploymentIdentities } from './deployment-ownership.mjs';

export function recoverablePreparation(record) {
  const preparation = record?.preparation, plan = preparation?.intent;
  return preparation?.phase === 'reserved' && !preparation.recovery &&
    Object.keys(preparation.resources ?? {}).length === 0 && plan?.application?.declaration?.schemaVersion === 2 &&
    !plan.operation && !plan.previewOf && !plan.verificationOf && record.accountIds?.length === 1 &&
    Object.keys(plan.resources).length > 0 && Object.values(plan.resources).every(row => row.provision && row.remoteId === null) &&
    !Object.values(plan.credentials ?? {}).some(value => value.startsWith('bootstrap:'));
}

// 只扩展原任务记录；旧控制面仍会拒绝 resuming，不可能将它误认为新任务重放。
export function beginPreparationRecovery(vault, owner, taskId, digest, recoveryId) {
  connectedTaskId(taskId);
  return vault.ctx.storage.transactionSync(() => {
    vault.deploymentGuard(owner);
    const sql = vault.ctx.storage.sql;
    const record = JSON.parse(sql.exec('SELECT record FROM connection_deployments WHERE task=?', taskId).one().record);
    requireSba(recoverablePreparation(record) && record.digest === digest && record.preparation.intent.digest === digest);
    for (const ref of Object.values(record.connections)) vault.activeConnection(ref.id, ref.revision);
    record.preparation.phase = 'resuming';
    record.preparation.recovery = { id: recoveryId, startedAt: Date.now() };
    sql.exec('UPDATE connection_deployments SET record=? WHERE task=?', JSON.stringify(record), taskId);
    return record;
  });
}

function legacyIdentities(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => typeof item === 'string' && ['name', 'url', 'id', 'kvId', 'databaseId', 'bucket', 'bucketName'].includes(key) ? [item] : legacyIdentities(item));
}

export async function preparationRecoveryRequest(env, vault, session, action, input) {
  requireSba(connectedEnabled(env));
  exactSba(input, action === 'resume-plan' ? ['taskId'] : ['taskId', 'digest', 'expiresAt', 'confirmation']);
  connectedTaskId(input.taskId);
  const record = (await vault.deploymentIndex(session.actor)).find(row => row.taskId === input.taskId);
  requireSba(recoverablePreparation(record));
  requireSba(await connectedStub(env, input.taskId).uninitialized());
  const plan = record.preparation.intent, current = connectedSbaPolicy(env, plan.application.manifest.runtime);
  // 固定应用、配置和执行器；控制面配置漂移不能偷偷改变已确认任务。
  requireSba(record.digest === plan.digest && canonicalSba({ ...plan.policy.github, applicationRepository: current.github.applicationRepository }) === canonicalSba(current.github) && plan.policy.runnerOrigin === current.runnerOrigin);
  const legacy = legacyIdentities(sbaPolicy(env).configuration);
  requireSba(deploymentIdentities(plan).every(value => !legacy.includes(value)));
  if (action === 'resume-plan') {
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
