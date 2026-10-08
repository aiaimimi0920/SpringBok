import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { serviceEntries } from './service-instance.mjs';
import { deploymentTargets, deploymentValue } from './deployment-contract.mjs';
import { exactSba, requireSba, canonicalSba, sbaDigest, sbaRequest } from './sba-control.mjs';
import { compareVersions } from '../src/sba/contract.mjs';
import { resourceIdentity, validatePreviewInventory } from '../src/sba/preview.mjs';

export const continuesInstance = plan => ['update', 'destroy-preview'].includes(plan.operation?.action);
export const createsResources = plan => !!plan.accounts && !continuesInstance(plan);
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
  if (remove) {
    requireSba(old.operation?.action === 'preview' && old.previewOf && job.result.lifecycle?.resources.every(row => row.status === 'created'));
    for (const reference of Object.values(old.connections)) vault.activeConnection(reference.id, reference.revision);
    const context = { instanceId: input.instanceId, previewTaskId: input.previousTaskId, resultDigest: await sbaDigest(job.result), resources: previewInventory(old) };
    requireSba(canonicalSba(context.resources) === canonicalSba(job.request.context.resources));
    const operation = { action: 'destroy-preview', instanceId: input.instanceId, previousTaskId: input.previousTaskId,
      previous: { sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion }, previousResultDigest: context.resultDigest, context };
    const plan = { ...old, operation };
    sbaRequest(plan.policy, 'dc-' + '0'.repeat(32), plan.application.manifest, operation);
    return { ...plan, digest: await sbaDigest({ ...plan, digest: null }) };
  }
  requireSba(input.action === 'rehearse' && !old.previewOf && typeof input.environment === 'string' && /^test-[a-f0-9]{12}$/.test(input.environment) && input.environment !== old.policy.environment);
  const candidate = await vault.deploymentDraft(owner, { action: 'application', github: old.connections.github, repository: old.application.repository, sourceSha: input.sourceSha });
  const d = candidate.declaration;
  requireSba(candidate.manifest.schemaVersion === 3 && d.schemaVersion === 2 && candidate.manifest.id === old.application.manifest.id && input.sourceSha !== job.request.sourceSha && compareVersions(candidate.manifest.version, job.request.applicationVersion) > 0);
  // 每个可写目标必须从新实例名派生，不能默默继承线上 Worker/域名。
  requireSba(d.targets.every(target => d.fields.find(field => canonicalSba(field.path) === canonicalSba(target.path))?.template?.includes('{instance}')));
  requireSba(d.targets.some(target => target.kind === 'domain'));
  requireSba(old.application.declaration.resources.every(resource => d.resources.some(row => row.key === resource.key && row.kind === resource.kind)));
  const values = Object.fromEntries(d.fields.filter(field => field.template === null).map(field => [field.path.join('.'), deploymentValue(old.configuration, field.path)]));
  const accounts = Object.fromEntries(d.accounts.slice(1).map(account => { const ref = old.connections['cloudflare_' + account.key]; requireSba(ref); return [account.key, ref]; }));
  const plan = await vault.deploymentDraft(owner, { action: 'preview', github: old.connections.github, repository: old.application.repository, sourceSha: input.sourceSha,
    cloudflare: old.connections.cloudflare, environment: input.environment, values, resources: {}, accounts });
  const source = { instanceId: input.instanceId, taskId: input.previousTaskId, sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion,
    environment: old.policy.environment, configuration: old.configuration, resources: previewInventory(old), resultDigest: await sbaDigest(job.result) };
  validatePreviewInventory(source.resources);
  const context = { source, resources: previewInventory(plan), urls: deploymentTargets(d, plan.configuration).filter(row => row.kind === 'domain').map(row => row.value) };
  const operation = { action: 'preview', previous: { sourceSha: source.sourceSha, applicationVersion: source.applicationVersion }, context };
  const previewOf = { instanceId: input.instanceId, taskId: input.previousTaskId, sourceSha: source.sourceSha, applicationVersion: source.applicationVersion, environment: source.environment };
  // 留出生成资源 ID 的空间，在任何云写入之前拒绝过大的请求。
  requireSba(new TextEncoder().encode(canonicalSba({ ...plan.policy.configuration, context })).length < 40000);
  return { ...plan, operation, previewOf, digest: await sbaDigest({ plan, operation, previewOf }) };
}
