// 清理恢复复用 repair 派发，但不伪装成发布或保数据修复。
import { validatePreviewContext, validatePreviewResult } from './preview.mjs';

const requireValue = value => { if (!value) throw new Error('SBA_REPAIR_INVALID'); };
export const repairedCleanup = request => request.action === 'repair' && Object.hasOwn(request.context ?? {}, 'cleanup');
export const repairCleanupContext = request => request.action === 'destroy-preview'
  ? { sourceSha: request.sourceSha, applicationVersion: request.applicationVersion, context: request.context }
  : repairedCleanup(request) ? request.context.cleanup : null;
// Absence of lifecycle is not proof of zero writes. The application must also authenticate
// its original provenance, unchanged target and unconsumed durable authority before any write.
export const cleanupRepairable = job => !!repairCleanupContext(job?.request ?? {}) && job?.status === 'failed' &&
  job.result?.status === 'failed' && !Object.hasOwn(job.result, 'lifecycle');
export const cleanupRepairRequest = request => ({ ...request, action: 'destroy-preview',
  sourceSha: request.context.cleanup.sourceSha, applicationVersion: request.context.cleanup.applicationVersion,
  previous: { sourceSha: request.context.cleanup.sourceSha, applicationVersion: request.context.cleanup.applicationVersion },
  context: request.context.cleanup.context });

export function validateCleanupRepairContext(request, compareVersions) {
  const value = request.context.cleanup;
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 3 &&
    ['sourceSha', 'applicationVersion', 'context'].every(key => Object.hasOwn(value, key)));
  requireValue(typeof value.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(value.sourceSha) && value.sourceSha !== request.sourceSha &&
    compareVersions(value.applicationVersion, request.previous.applicationVersion) <= 0);
  requireValue(!Object.hasOwn(request.context, 'preview') && !Object.hasOwn(request.context, 'previewBaseline'));
  validatePreviewContext(cleanupRepairRequest(request));
  requireValue(![request.taskId, request.context.parentTaskId].includes(value.context.previewTaskId) &&
    ![request.taskId, request.context.parentTaskId].includes(value.context.instanceId));
}

export function validateCleanupRepairResult(value, request) {
  validatePreviewResult(value, cleanupRepairRequest(request));
  if (value.status === 'succeeded') requireValue(value.checks.some(row => row.id === 'repair-completed' && row.passed));
}
