// Partial cleanup is opt-in. Evidence is derived from a completed authenticated parent, never from form input.
import { repairCleanupContext, cleanupRepairRequest } from './cleanup-repair.mjs';
import { validatePreviewResult } from './preview.mjs';

const requireValue = value => { if (!value) throw new Error('SBA_REPAIR_INVALID'); };
const task = value => typeof value === 'string' && /^dc-[a-f0-9]{32}$/.test(value);
const passed = (result, id) => result?.checks?.some(row => row.id === id && row.passed === true);
export const partialCleanupRepairable = job => !!repairCleanupContext(job?.request ?? {}) &&
  ['failed', 'unknown'].includes(job?.status) && job.result?.status === job.status &&
  (!!job.request.context?.cleanupProgress || (passed(job.result, 'preview-authority-verified') &&
    passed(job.result, 'preview-ingress-stopped') && !!job.result.lifecycle));

export function repairCleanupProgress(job) {
  if (!partialCleanupRepairable(job)) return null;
  const inherited = job.request.context.cleanupProgress;
  const progress = inherited ? { consumedTaskId: inherited.consumedTaskId, permitAt: inherited.permitAt,
    journalTaskId: passed(job.result, 'cleanup-resume-claim-persisted') ? job.request.taskId : inherited.journalTaskId }
    : { consumedTaskId: job.request.taskId, permitAt: job.permitAt, journalTaskId: null };
  return { ...progress, parentResult: structuredClone(job.result) };
}

export function validateCleanupProgress(request) {
  const value = request.context.cleanupProgress;
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 &&
    ['consumedTaskId', 'permitAt', 'journalTaskId', 'parentResult'].every(key => Object.hasOwn(value, key)));
  requireValue(task(value.consumedTaskId) && value.consumedTaskId !== request.taskId &&
    Number.isSafeInteger(value.permitAt) && value.permitAt > 0 &&
    (value.journalTaskId === null || task(value.journalTaskId) && value.journalTaskId !== request.taskId));
  const parent = value.parentResult;
  requireValue(parent && parent.schemaVersion === 3 && parent.taskId === request.context.parentTaskId &&
    parent.sourceSha === request.previous.sourceSha && parent.applicationVersion === request.previous.applicationVersion &&
    ['destroy-preview', 'repair'].includes(parent.action) && ['failed', 'unknown'].includes(parent.status) &&
    parent.errorCode === request.context.errorCode && Array.isArray(parent.checks) && parent.checks.length <= 30 &&
    parent.checks.every(row => row && Object.keys(row).length === 2 && typeof row.id === 'string' &&
      /^[a-z][a-z0-9-]{1,62}$/.test(row.id) && typeof row.passed === 'boolean'));
  requireValue(Object.keys(parent).every(key => ['schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion', 'status', 'checks', 'errorCode', 'lifecycle'].includes(key)));
  validatePreviewResult(parent, cleanupRepairRequest(request));
}
