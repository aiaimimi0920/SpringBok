import { connectedEnabled, connectedStateBundle } from './connected-api.mjs';
import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { serviceId, serviceSummary } from './service-instance.mjs';
import { exactSba, requireSba } from './sba-control.mjs';
import { importedId } from './service-import.mjs';
import { deletionInventory } from './service-deletion-provider.mjs';
import { canVerifyService, verificationState } from './service-verification.mjs';
import { repairEnabled, repairableJob } from './service-repair.mjs';
import { recoverablePreparation } from './preparation-recovery.mjs';
import { canRestartUpdate } from './unstarted-update-recovery.mjs';
import { completedPreview } from './service-preview.mjs';
import { repairedCleanup } from '../src/sba/cleanup-repair.mjs';
import { retirementSupported } from './service-retirement.mjs';

async function deletionState(env, vault, owner, state, lookup = null) {
  const retirement = lookup ? lookup.retirement : await vault.retirementRecord(owner, state.instance.id);
  if (retirement) return { ...state, retirement, status: 'retired', canUpdate: false, canRepair: false, canPreview: false, canDeletePreview: false, canDelete: false, canVerify: false, canRestart: false, canResume: false, canRetire: false };
  const deletion = lookup ? lookup.deletion : await vault.deletionRecord(owner, state.instance.id);
  if (deletion) return { ...state, deletion, status: deletion.status === 'deleting' && Date.now() - deletion.updatedAt > 120000 ? 'delete-unknown' : deletion.status, canUpdate: false, canRepair: false, canPreview: false, canDeletePreview: false, canDelete: false, canReconcileDeletion: connectedEnabled(env) && deletion.status === 'delete-unknown' };
  let supported = false; try { deletionInventory(state.instance); supported = !!state.instance.connections?.cloudflare; } catch { /* 未支持的资源不能部分销毁。 */ }
  return { ...state, canRetire: connectedEnabled(env) && retirementSupported(state.instance) && ['succeeded', 'deployed-unverified'].includes(state.job?.status), canDelete: connectedEnabled(env) && supported && !state.instance.previewOf && (state.status === 'imported' || ['succeeded', 'deployed-unverified'].includes(state.job?.status)) };
}

export function importedState(record) {
  const { candidate } = record;
  return { instance: candidate.instance, status: 'imported', taskId: null, job: null, history: [], canUpdate: false,
    observedAt: candidate.observedAt, components: candidate.components, provenance: candidate.provenance, definition: candidate.definition };
}

export async function serviceIndex(vault, owner) {
  const { deployments, excluded, imported } = await vault.serviceIndexData(owner);
  const seen = new Set(excluded), services = [];
  for (const entry of deployments) {
    const id = serviceId(entry); if (seen.has(id)) continue; seen.add(id);
    services.push({ id, taskId: entry.taskId, createdAt: entry.createdAt, summary: entry.service ?? null });
  }
  for (const record of imported) {
    if (seen.has(record.id)) continue; seen.add(record.id);
    services.push({ id: record.id, taskId: null, createdAt: record.createdAt, summary: record.candidate.instance });
  }
  return services;
}
export async function serviceState(env, vault, owner, input) {
  exactSba(input, ['instanceId', 'reconcile']); requireSba(typeof input.reconcile === 'boolean');
  const lookup = await vault.serviceLookup(owner, input.instanceId);
  if (importedId(input.instanceId)) { requireSba(lookup.imported); return deletionState(env, vault, owner, importedState(lookup.imported), lookup); }
  connectedTaskId(input.instanceId);
  const { entries } = lookup; requireSba(entries.length);
  const latest = entries[0], { publicState: record, bundle } = await connectedStateBundle(env, owner, latest.taskId, input.reconcile, latest);
  const history = entries.map(entry => ({ taskId: entry.taskId, createdAt: entry.createdAt, action: entry.service?.action ?? 'deploy', application: entry.service?.application ?? null }));
  if (record.status === 'preparation-unconfirmed') return { ...record, instance: latest.service ?? { id: input.instanceId }, history, canUpdate: false, canResume: connectedEnabled(env) && recoverablePreparation(latest) && await connectedStub(env, latest.taskId).uninitialized() };
  const { plan } = bundle.record;
  const verification = await verificationState(env, owner, latest.taskId, input.reconcile, bundle.verification);
  const terminal = ['succeeded', 'deployed-unverified'].includes(record.job?.status), previewInstance = !!plan.previewOf;
  const previewDeleted = (plan.operation?.action === 'destroy-preview' || repairedCleanup(record.job?.request ?? {})) && record.job?.status === 'succeeded';
  if (previewDeleted) await vault.markPreviewDeleted(owner, input.instanceId);
  return deletionState(env, vault, owner, { ...record, verification, canVerify: connectedEnabled(env) && !verification && canVerifyService(plan, record.job), instance: serviceSummary(latest.taskId, plan), history, configuration: plan.configuration, declaration: plan.application.declaration,
    canUpdate: connectedEnabled(env) && terminal && !previewInstance,
    canRestart: connectedEnabled(env) && canRestartUpdate(plan, record.job) && record.attempts.length < 3,
    canRepair: connectedEnabled(env) && repairEnabled(env) && repairableJob(plan, bundle.job),
    canPreview: connectedEnabled(env) && terminal && !previewInstance,
    canDeletePreview: connectedEnabled(env) && completedPreview(plan, record.job),
    testUrls: completedPreview(plan, record.job) ? record.job.result.lifecycle.urls : [],
    ...(previewDeleted ? { status: 'deleted' } : {}) }, lookup);
}
