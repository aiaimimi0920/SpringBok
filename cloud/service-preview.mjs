import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { serviceEntries } from './service-instance.mjs';
import { deploymentTargets, deploymentValue } from './deployment-contract.mjs';
import { exactSba, requireSba, requirePlan, canonicalSba, sbaDigest, sbaRequest, connectedSbaPolicy } from './sba-control.mjs';
import { compareVersions } from '../src/sba/contract.mjs';
import { resourceIdentity, validatePreviewInventory } from '../src/sba/preview.mjs';
import { repairedPreview } from '../src/sba/repair.mjs';
import { applicationRepository } from './service-catalog.mjs';

export function resolveInstanceConnections(vault, old) {
  const connections = {}, runtimeAccount = old.accounts?.runtime?.accountId ?? deploymentValue(old.configuration, old.application.declaration.accountPath);
  for (const [key, ref] of Object.entries(old.connections)) {
    const { row } = vault.activeConnection(ref.id);
    if (key === 'github') {
      requireSba(row.provider === 'github'); applicationRepository(row, old.application.repository);
    } else {
      const expected = key === 'cloudflare' ? runtimeAccount : old.accounts?.[key.slice('cloudflare_'.length)]?.accountId;
      requireSba(row.provider === 'cloudflare' && typeof expected === 'string' && row.target === expected);
    }
    connections[key] = { id: row.id, revision: row.revision };
  }
  return connections;
}

export const continuesInstance = plan => ['update', 'destroy-preview', 'repair'].includes(plan.operation?.action);
export const createsResources = plan => !!plan.accounts && !continuesInstance(plan);
export const completedPreview = (plan, job) => !!plan.previewOf &&
  (plan.operation?.action === 'preview' || repairedPreview(job?.request ?? {})) &&
  ['succeeded', 'deployed-unverified'].includes(job?.status) && job.result?.status === job.status &&
  job.result.lifecycle?.resources.every(row => row.status === 'created');
export function previewInventory(plan) {
  const accountId = deploymentValue(plan.configuration, plan.application.declaration.accountPath);
  return [...Object.entries(plan.resources).map(([key, row]) => ({ key: 'resource-' + key, kind: row.kind, accountId: row.accountId, remoteId: row.remoteId, name: row.name })),
    ...deploymentTargets(plan.application.declaration, plan.configuration).map((row, index) => ({ key: 'target-' + index, kind: row.kind, accountId: row.accountId ?? accountId, remoteId: row.value, name: row.value }))];
}
export function finalizePreview(plan) {
  if (plan.operation?.action !== 'preview') return plan;
  const resources = previewInventory(plan); validatePreviewInventory(resources);
  const originals = new Set(plan.operation.context.source.resources.map(resourceIdentity));
  requireSba(resources.every(row => !originals.has(resourceIdentity(row))));
  return { ...plan, operation: { ...plan.operation, context: { ...plan.operation.context, resources } } };
}
async function currentSource(vault, owner, input) {
  connectedTaskId(input.instanceId); connectedTaskId(input.previousTaskId);
  const entries = serviceEntries(await vault.deploymentIndex(owner), input.instanceId);
  requireSba(entries.length && entries[0].taskId === input.previousTaskId);
  const stub = connectedStub(vault.env, input.previousTaskId), { plan } = await stub.bootstrap(owner), job = await stub.inspect(owner);
  requireSba((plan.operation?.instanceId ?? input.previousTaskId) === input.instanceId && ['succeeded', 'deployed-unverified'].includes(job?.status) && job.result?.status === job.status);
  return { plan, job };
}
export async function servicePreviewDraft(vault, owner, input) {
  const remove = input.action === 'destroy-preview';
  exactSba(input, ['action', 'instanceId', 'previousTaskId', ...(remove ? [] : ['sourceSha', 'environment'])]);
  const { plan: old, job } = await currentSource(vault, owner, input);
  const connections = resolveInstanceConnections(vault, old);
  if (remove) {
    requireSba(completedPreview(old, job));
    const context = { instanceId: input.instanceId, previewTaskId: input.previousTaskId, resultDigest: await sbaDigest(job.result), resources: previewInventory(old) };
    requireSba(canonicalSba(context.resources) === canonicalSba((repairedPreview(job.request) ? job.request.context.preview : job.request.context).resources));
    const operation = { action: 'destroy-preview', instanceId: input.instanceId, previousTaskId: input.previousTaskId,
      previous: { sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion }, previousResultDigest: context.resultDigest, context };
    const executor = connectedSbaPolicy(vault.env, old.application.manifest.runtime).github;
    const policy = { ...old.policy, github: { ...executor, applicationRepository: old.policy.github.applicationRepository } };
    const plan = { ...old, connections, policy, operation };
    sbaRequest(plan.policy, 'dc-' + '0'.repeat(32), plan.application.manifest, operation);
    return { ...plan, digest: await sbaDigest({ ...plan, digest: null }) };
  }
  requireSba(input.action === 'rehearse' && !old.previewOf && typeof input.environment === 'string' && /^test-[a-f0-9]{12}$/.test(input.environment) && input.environment !== old.policy.environment);
  const candidate = await vault.deploymentDraft(owner, { action: 'application', github: connections.github, repository: old.application.repository, sourceSha: input.sourceSha });
  const d = candidate.declaration;
  requirePlan(candidate.manifest.schemaVersion === 3 && d.schemaVersion === 2 && candidate.manifest.id === old.application.manifest.id && canonicalSba(candidate.manifest.runtime) === canonicalSba(old.application.manifest.runtime), 'declaration-incompatible');
  requirePlan(input.sourceSha !== job.request.sourceSha && compareVersions(candidate.manifest.version, job.request.applicationVersion) > 0, 'version-not-newer');
  // 每个可写目标必须从新实例名派生，不能默默继承线上 Worker/域名。
  requireSba(d.targets.every(target => target.kind === 'email-routing' || d.fields.find(field => canonicalSba(field.path) === canonicalSba(target.path))?.template?.includes('{instance}')));
  requireSba(d.targets.some(target => ['domain', 'worker', 'pages'].includes(target.kind)));
  requireSba(old.application.declaration.resources.every(resource => d.resources.some(row => row.key === resource.key && row.kind === resource.kind)));
  const values = Object.fromEntries(d.fields.filter(field => field.template === null).map(field => [field.path.join('.'), deploymentValue(old.configuration, field.path)]));
  for (const target of d.targets.filter(row => row.kind === 'email-routing')) values[target.path.join('.')] = null;
  const accounts = Object.fromEntries(d.accounts.slice(1).map(account => { const ref = connections['cloudflare_' + account.key]; requireSba(ref); return [account.key, ref]; }));
  const plan = await vault.deploymentDraft(owner, { action: 'preview', github: connections.github, repository: old.application.repository, sourceSha: input.sourceSha,
    cloudflare: connections.cloudflare, environment: input.environment, values, resources: {}, accounts,
    ...(old.applicationSecrets?{applicationSecrets:old.applicationSecrets}:{}) }, candidate);
  const source = { instanceId: input.instanceId, taskId: input.previousTaskId, sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion,
    environment: old.policy.environment, configuration: old.configuration, resources: previewInventory(old), resultDigest: await sbaDigest(job.result) };
  validatePreviewInventory(source.resources, { source: true });
  const context = { source, resources: previewInventory(plan), urls: deploymentTargets(d, plan.configuration).filter(row => row.kind === 'domain').map(row => row.value) };
  const operation = { action: 'preview', previous: { sourceSha: source.sourceSha, applicationVersion: source.applicationVersion }, context };
  const previewOf = { instanceId: input.instanceId, taskId: input.previousTaskId, sourceSha: source.sourceSha, applicationVersion: source.applicationVersion, environment: source.environment };
  // 留出生成资源 ID 的空间，在任何云写入之前拒绝过大的请求。
  requireSba(new TextEncoder().encode(canonicalSba({ ...plan.policy.configuration, context })).length < 40000);
  return { ...plan, operation, previewOf, digest: await sbaDigest({ plan, operation, previewOf }) };
}
