import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { sbaDigest, sbaRequest, canonicalSba, requireSba } from './sba-control.mjs';
import { deploymentTargets } from './deployment-contract.mjs';

export const serviceId = entry => entry.service?.id ?? entry.taskId;
export const serviceEntries = (index, id) => index.filter(entry => serviceId(entry) === id);
const identities = resources => Object.fromEntries(Object.entries(resources).map(([key, r]) => [key, { kind: r.kind, accountId: r.accountId, remoteId: r.remoteId, name: r.name }]));

export function serviceSummary(taskId, plan) {
  return { id: plan.operation?.instanceId ?? taskId, parentTaskId: plan.operation?.previousTaskId ?? null,
    action: plan.operation?.action ?? 'deploy', previous: plan.operation?.previous ?? null,
    application: { id: plan.application.manifest.id, name: plan.application.manifest.name, version: plan.application.manifest.version,
      repository: plan.application.repository, sourceSha: plan.application.sourceSha },
    environment: plan.policy.environment, accountId: plan.application.declaration.accountPath.reduce((value,key)=>value[key],plan.configuration), connections: plan.connections, resources: plan.resources,
    targets: deploymentTargets(plan.application.declaration, plan.configuration) };
}

export async function updateOperation(vault, owner, instance, plan) {
  connectedTaskId(instance.id); connectedTaskId(instance.previousTaskId);
  const index = await vault.deploymentIndex(owner), entries = serviceEntries(index, instance.id);
  requireSba(entries.length && entries[0].taskId === instance.previousTaskId);
  const stub = connectedStub(vault.env, instance.previousTaskId), bootstrap = await stub.bootstrap(owner), job = await stub.inspect(owner);
  requireSba(job && ['succeeded', 'deployed-unverified'].includes(job.status) && job.result?.status === job.status);
  const old = bootstrap.plan;
  requireSba((old.operation?.instanceId ?? instance.previousTaskId) === instance.id &&
    plan.application.repository.toLowerCase() === old.application.repository.toLowerCase() &&
    plan.application.manifest.id === old.application.manifest.id && plan.policy.environment === old.policy.environment &&
    plan.connections.cloudflare.id === old.connections.cloudflare.id &&
    canonicalSba(plan.configuration) === canonicalSba(old.configuration) &&
    canonicalSba(identities(plan.resources)) === canonicalSba(identities(old.resources)) &&
    canonicalSba(deploymentTargets(plan.application.declaration, plan.configuration)) === canonicalSba(deploymentTargets(old.application.declaration, old.configuration)));
  const operation = { action: 'update', instanceId: instance.id, previousTaskId: instance.previousTaskId,
    previous: { sourceSha: job.request.sourceSha, applicationVersion: job.request.applicationVersion },
    previousResultDigest: await sbaDigest(job.result) };
  sbaRequest(plan.policy, 'service-update-validation', plan.application.manifest, operation);
  return operation;
}
