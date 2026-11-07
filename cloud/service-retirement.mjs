import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { serviceEntries, serviceSummary } from './service-instance.mjs';
import { exactSba, requireSba, sbaDigest, canonicalSba } from './sba-control.mjs';
import { openToken } from './connections-crypto.mjs';
import { resourceAbsent } from './service-deletion-provider.mjs';
import { readJson } from './connections-provider.mjs';
import { githubScope } from './deployment-suite.mjs';
import { applicationRepository } from './service-catalog.mjs';

// 独立登记投影；不修改部署历史、执行 lane、资源 claim 或业务回执。
export function retirementIndex(vault, owner) {
  vault.guard(owner);
  const sql = vault.ctx.storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS service_retirements (instance TEXT PRIMARY KEY, record TEXT NOT NULL)');
  return sql.exec('SELECT record FROM service_retirements').toArray().map(row => JSON.parse(row.record));
}
export function retirementRecord(vault, owner, instanceId) { return retirementIndex(vault, owner).find(row => row.instanceId === instanceId) ?? null; }
export function assertNotRetired(vault, owner, instanceId) { requireSba(!retirementRecord(vault, owner, instanceId)); }

async function source(vault, owner, input) {
  exactSba(input, ['instanceId', 'previousTaskId']); connectedTaskId(input.instanceId); connectedTaskId(input.previousTaskId);
  const entry = serviceEntries(vault.deploymentIndex(owner), input.instanceId)[0];
  requireSba(entry?.taskId === input.previousTaskId);
  const stub = connectedStub(vault.env, entry.taskId), { plan } = await stub.bootstrap(owner), job = await stub.inspect(owner);
  requireSba(!plan.previewOf && plan.application.declaration.target === 'cloudflare-suite'
    && ['succeeded', 'deployed-unverified'].includes(job?.status) && job.result?.status === job.status);
  return { instance: serviceSummary(entry.taskId, plan), revision: await sbaDigest(job.result) };
}
export function retirementSupported(instance) {
  try { retirementInventory(instance); return true; } catch { return false; }
}
function retirementInventory(instance) {
  requireSba(instance && /^[a-f0-9]{32}$/.test(instance.accountId) && !instance.previewOf);
  const targets = instance.targets, resources = Object.values(instance.resources);
  requireSba(targets.length <= 8 && resources.length > 0 && resources.length <= 24);
  const workers = targets.filter(t => t.kind === 'worker'), pages = targets.filter(t => t.kind === 'pages'), actions = targets.filter(t => t.kind === 'github-actions');
  requireSba(workers.length === 1 && pages.length === 1 && actions.length === 1);
  const name = v => typeof v === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(v);
  requireSba(name(workers[0].value) && name(pages[0].value));
  const repository = instance.application.repository;
  requireSba(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && actions[0].accountId === githubScope(repository) && /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@[a-z][a-z0-9-]{1,62}$/.test(actions[0].value));
  requireSba(targets.every(t => t.kind === 'github-actions' || t.accountId === instance.accountId));
  for (const t of targets) {
    if (['worker','pages','github-actions'].includes(t.kind)) continue;
    requireSba(t.kind === 'domain' && (t.value === `https://${pages[0].value}.pages.dev`
      || new RegExp(`^https://${workers[0].value}\\.[a-z0-9-]+\\.workers\\.dev$`).test(t.value)));
  }
  requireSba(resources.every(r => r.accountId === instance.accountId && (r.kind === 'd1'
    ? /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.remoteId)
    : r.kind === 'r2' && name(r.remoteId) && r.name === r.remoteId)));
  return [...resources.map(({ kind, accountId, remoteId, name }) => ({ kind, accountId, remoteId, name })),
    ...[...workers, ...pages, ...actions].map(t => ({ kind: t.kind, accountId: t.accountId, remoteId: t.value, name: t.value }))];
}
async function token(vault, owner, instance, provider) {
  // 只读核验使用原连接 ID 的当前已验证凭据；历史部署引用不变。
  const ref = instance.connections[provider], { row, sealed } = vault.activeConnection(ref.id);
  requireSba(row.provider === provider && (provider !== 'cloudflare' || row.target === instance.accountId));
  if (provider === 'github') applicationRepository(row, instance.application.repository);
  return { credential: await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed), ref: { id: row.id, revision: row.revision } };
}
async function absentPages(row, credential) {
  let missing = false;
  const body = await readJson(`https://api.cloudflare.com/client/v4/accounts/${row.accountId}/pages/projects/${row.remoteId}`, credential, false, async (url, options) => {
    const response = await fetch(url, options);
    if (response.status !== 404) return response;
    missing = true; return new Response(response.body, { status: 200, headers: response.headers });
  });
  requireSba(missing && body.success === false && body.result == null && body.errors?.length === 1 && body.errors[0].code === 8000007);
}
async function absentActions(row, credential) {
  const repository = row.accountId.slice(7), [workflow, environment] = row.remoteId.split('@');
  const base = `https://api.github.com/repos/${repository}`;
  // 完整环境列表避免把权限 404 当成不存在；共享 workflow 本身不删除。
  const body = await readJson(base + '/environments?per_page=100', credential, true);
  requireSba(Array.isArray(body.environments) && body.total_count === body.environments.length && body.total_count <= 100
    && body.environments.every(r => typeof r.name === 'string') && !body.environments.some(r => r.name.toLowerCase() === environment.toLowerCase()));
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = await readJson(base + `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&status=${status}`, credential, true);
    requireSba(runs.total_count === 0 && Array.isArray(runs.workflow_runs) && runs.workflow_runs.length === 0);
  }
}
export async function retirementPlan(vault, owner, input) {
  assertNotRetired(vault, owner, input.instanceId);
  requireSba(!vault.deletionRecord(owner, input.instanceId));
  const current = await source(vault, owner, input), resources = retirementInventory(current.instance);
  const cloudflare = await token(vault, owner, current.instance, 'cloudflare'), github = await token(vault, owner, current.instance, 'github');
  for (const row of resources) {
    if (row.kind === 'pages') await absentPages(row, cloudflare.credential);
    else if (row.kind === 'github-actions') await absentActions(row, github.credential);
    else requireSba(await resourceAbsent(row, cloudflare.credential));
  }
  const connections = { cloudflare: cloudflare.ref, github: github.ref };
  for (const ref of Object.values(connections)) vault.activeConnection(ref.id, ref.revision);
  const plan = { ...input, ...current, connections, resources: resources.map(row => ({ ...row, absent: true })) };
  return { ...plan, digest: await sbaDigest(plan) };
}
export async function retireService(vault, owner, input) {
  exactSba(input, ['operationId', 'plan', 'expiresAt']); connectedTaskId(input.operationId);
  const prior = retirementRecord(vault, owner, input.plan.instanceId);
  if (prior) { requireSba(prior.operationId === input.operationId && prior.digest === input.plan.digest); return prior; }
  const fresh = await retirementPlan(vault, owner, { instanceId: input.plan.instanceId, previousTaskId: input.plan.previousTaskId });
  requireSba(canonicalSba(fresh) === canonicalSba(input.plan) && input.expiresAt > Date.now());
  return vault.ctx.storage.transactionSync(() => {
    assertNotRetired(vault, owner, fresh.instanceId);
    requireSba(!vault.deletionRecord(owner, fresh.instanceId) && serviceEntries(vault.deploymentIndex(owner), fresh.instanceId)[0]?.taskId === fresh.previousTaskId);
    for (const ref of Object.values(fresh.connections)) vault.activeConnection(ref.id, ref.revision);
    const record = { ...fresh, operationId: input.operationId, status: 'retired', retiredAt: Date.now() };
    vault.ctx.storage.sql.exec('INSERT INTO service_retirements VALUES(?,?)', fresh.instanceId, JSON.stringify(record));
    return record;
  });
}
