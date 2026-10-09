import { connectedStub, accountStub, connectedTaskId } from './connected-store.mjs';
import { serviceEntries, serviceSummary } from './service-instance.mjs';
import { importedId } from './service-import.mjs';
import { openToken } from './connections-crypto.mjs';
import { requireSba, exactSba, sbaDigest } from './sba-control.mjs';
import { deletionInventory, inspectDeletion, sameDeletion, removeResource, resourceAbsent } from './service-deletion-provider.mjs';

export function deletionGuard(vault, owner) {
  vault.resourceGuard(owner);
  vault.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS service_deletions (instance TEXT PRIMARY KEY, record TEXT NOT NULL)');
}
export function deletionRecord(vault, owner, instanceId) {
  deletionGuard(vault, owner);
  const row = vault.ctx.storage.sql.exec('SELECT record FROM service_deletions WHERE instance=?', instanceId).toArray()[0];
  return row ? JSON.parse(row.record) : null;
}
function save(vault, record) { vault.ctx.storage.sql.exec('INSERT INTO service_deletions VALUES(?,?) ON CONFLICT(instance) DO UPDATE SET record=excluded.record', record.instanceId, JSON.stringify(record)); }
export function assertNotDeleting(vault, owner, instanceId) { requireSba(!deletionRecord(vault, owner, instanceId)); }
async function source(vault, owner, input) {
  exactSba(input, ['instanceId', 'previousTaskId']);
  if (importedId(input.instanceId)) {
    requireSba(input.previousTaskId === null);
    const row = vault.importedIndex(owner).find(r => r.id === input.instanceId); requireSba(row);
    return { instance: row.candidate.instance, revision: row.candidate.digest };
  }
  connectedTaskId(input.instanceId); connectedTaskId(input.previousTaskId);
  const entries = serviceEntries(vault.deploymentIndex(owner), input.instanceId);
  requireSba(entries[0]?.taskId === input.previousTaskId);
  const stub = connectedStub(vault.env, input.previousTaskId), { plan } = await stub.bootstrap(owner), job = await stub.inspect(owner);
  requireSba(!plan.previewOf && ['succeeded', 'deployed-unverified'].includes(job?.status) && job.result?.status === job.status);
  return { instance: serviceSummary(input.previousTaskId, plan), revision: await sbaDigest(job.result) };
}
async function credentials(vault, owner, instance, rows) {
  const tokens = {};
  for (const account of new Set(rows.map(r => r.accountId))) {
    const references = Object.entries(instance.connections).filter(([key]) => key === 'cloudflare' || key.startsWith('cloudflare_'));
    for (const [, ref] of references) {
      const { row, sealed } = vault.activeConnection(ref.id, ref.revision);
      if (row.provider === 'cloudflare' && row.target === account) tokens[account] = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed);
    }
    requireSba(tokens[account]);
  }
  return tokens;
}
export async function deletionPlan(vault, owner, input) {
  assertNotDeleting(vault, owner, input.instanceId);
  const current = await source(vault, owner, input), rows = deletionInventory(current.instance);
  const tokens = await credentials(vault, owner, current.instance, rows);
  const resources = await inspectDeletion(rows, tokens);
  assertNotDeleting(vault, owner, input.instanceId);
  const plan = { ...input, revision: current.revision, instance: current.instance, resources };
  return { ...plan, digest: await sbaDigest(plan) };
}
export async function deleteService(vault, owner, input) {
  exactSba(input, ['operationId', 'plan', 'expiresAt']); connectedTaskId(input.operationId);
  const existing = deletionRecord(vault, owner, input.plan.instanceId);
  if (existing) { requireSba(existing.operationId === input.operationId && existing.digest === input.plan.digest); return existing; }
  const { instanceId, previousTaskId } = input.plan;
  const fresh = await deletionPlan(vault, owner, { instanceId, previousTaskId }); requireSba(sameDeletion(fresh, input.plan));
  const tokens = await credentials(vault, owner, fresh.instance, fresh.resources);
  requireSba(input.expiresAt > Date.now());
  const record = { instanceId, previousTaskId, operationId: input.operationId, digest: fresh.digest, status: 'deleting', createdAt: Date.now(), updatedAt: Date.now(),
    resources: fresh.resources.map(r => ({ ...r, status: r.present ? 'pending' : 'absent' })), errorCode: null };
  // Await 之后再次锁定最新索引；确认与并发升级不能各自认为持有同一实例。
  vault.ctx.storage.transactionSync(() => {
    const concurrent = deletionRecord(vault, owner, instanceId); requireSba(!concurrent);
    if (!importedId(instanceId)) requireSba(serviceEntries(vault.deploymentIndex(owner), instanceId)[0]?.taskId === previousTaskId);
    save(vault, record);
  });
  try {
    for (const account of Object.keys(tokens).sort()) {
      const keys = deletionInventory(fresh.instance).filter(r => r.accountId === account).flatMap(r => [r.name, r.remoteId]);
      await accountStub(vault.env, account).claimDeletion(owner, instanceId, input.operationId, account, keys, fresh.digest);
    }
    const order = { domain: 0, worker: 1, d1: 2, kv: 3 };
    for (const row of [...record.resources].sort((a, b) => order[a.kind] - order[b.kind])) {
      if (row.status === 'absent') continue;
      row.status = 'deleting'; record.updatedAt = Date.now(); save(vault, record);
      await removeResource(row, tokens[row.accountId]);
      requireSba(await resourceAbsent(row, tokens[row.accountId]));
      row.status = 'removed'; record.updatedAt = Date.now(); save(vault, record);
    }
    // 所有资源再次读回后才释放归属。历史部署与删除回执仍保留。
    for (const row of record.resources) requireSba(await resourceAbsent(row, tokens[row.accountId]));
    for (const account of Object.keys(tokens).sort()) await accountStub(vault.env, account).finishDeletion(owner, instanceId, input.operationId, fresh.digest);
    for (const resource of Object.values(fresh.instance.resources)) vault.ctx.storage.sql.exec("DELETE FROM resources WHERE kind=? AND remote_id=? AND json_extract(metadata,'$.accountId')=?", resource.kind, resource.remoteId, resource.accountId);
    record.status = 'deleted';
  } catch {
    record.status = 'delete-unknown'; record.errorCode = 'SERVICE_DELETE_UNCONFIRMED';
    for (const row of record.resources) if (row.status === 'deleting') row.status = 'unknown';
  }
  record.updatedAt = Date.now(); save(vault, record); return record;
}
