import { connectedEnabled, connectedState } from './connected-api.mjs';
import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { serviceId, serviceEntries, serviceSummary } from './service-instance.mjs';
import { exactSba, requireSba } from './sba-control.mjs';
import { importedId } from './service-import.mjs';

export function importedState(record) {
  const { candidate } = record;
  return { instance: candidate.instance, status: 'imported', taskId: null, job: null, history: [], canUpdate: false,
    observedAt: candidate.observedAt, components: candidate.components, provenance: candidate.provenance, definition: candidate.definition };
}

export async function serviceIndex(vault, owner) {
  const index = await vault.deploymentIndex(owner), seen = new Set(), services = [];
  for (const entry of index) {
    const id = serviceId(entry); if (seen.has(id)) continue; seen.add(id);
    services.push({ id, taskId: entry.taskId, createdAt: entry.createdAt, summary: entry.service ?? null });
  }
  for (const record of await vault.importedIndex(owner)) services.push({ id: record.id, taskId: null, createdAt: record.createdAt, summary: record.candidate.instance });
  return services;
}
export async function serviceState(env, vault, owner, input) {
  exactSba(input, ['instanceId', 'reconcile']); requireSba(typeof input.reconcile === 'boolean');
  if (importedId(input.instanceId)) { const record = (await vault.importedIndex(owner)).find(row => row.id === input.instanceId); requireSba(record); return importedState(record); }
  connectedTaskId(input.instanceId);
  const entries = serviceEntries(await vault.deploymentIndex(owner), input.instanceId); requireSba(entries.length);
  const latest = entries[0], record = await connectedState(env, owner, latest.taskId, input.reconcile);
  const history = entries.map(entry => ({ taskId: entry.taskId, createdAt: entry.createdAt, action: entry.service?.action ?? 'deploy', application: entry.service?.application ?? null }));
  if (record.status === 'preparation-unconfirmed') return { ...record, instance: latest.service ?? { id: input.instanceId }, history, canUpdate: false };
  const { plan } = await connectedStub(env, latest.taskId).bootstrap(owner);
  return { ...record, instance: serviceSummary(latest.taskId, plan), history, configuration: plan.configuration, declaration: plan.application.declaration,
    canUpdate: connectedEnabled(env) && ['succeeded', 'deployed-unverified'].includes(record.job?.status) };
}
