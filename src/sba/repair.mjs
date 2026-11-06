// 修复是独立执行，不是重新运行原任务或把未知结果改成成功。
import { validatePreviewContext, validatePreviewResult } from './preview.mjs';
import { repairedCleanup, validateCleanupRepairContext, validateCleanupRepairResult } from './cleanup-repair.mjs';
import { validateCleanupProgress } from './cleanup-progress.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const errorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value);
const requireRepair = value => { if (!value) throw new Error('SBA_REPAIR_INVALID'); };
export const repairActions = repair => repair.fromActions ?? ['deploy', 'update', 'repair'];
export const repairedPreview = request => request.action === 'repair' && Object.hasOwn(request.context ?? {}, 'preview');
export const repairPreviewContext = request => request.action === 'preview' ? request.context : repairedPreview(request) ? request.context.preview : null;
export const repairPreviewBaseline = request => request.action === 'preview' ? { sourceSha: request.sourceSha, applicationVersion: request.applicationVersion, instanceId: request.taskId }
  : repairedPreview(request) ? request.context.previewBaseline ?? { ...request.previous, instanceId: request.context.parentTaskId } : null;
export const previewRepairRequest = request => ({ ...request, action: 'preview', context: request.context.preview,
  previous: { sourceSha: request.context.preview.source.sourceSha, applicationVersion: request.context.preview.source.applicationVersion } });

export function validateRepairs(manifest) {
  const enabled = Object.hasOwn(manifest.actions, 'repair');
  requireRepair(enabled === Object.hasOwn(manifest, 'repairs'));
  if (!enabled) return;
  requireRepair(manifest.schemaVersion === 3 && Array.isArray(manifest.repairs) && manifest.repairs.length > 0 && manifest.repairs.length <= 10);
  const seen = new Set();
  for (const repair of manifest.repairs) {
    requireRepair(exact(repair, ['id', 'name', 'fromErrorCodes', 'secretNames', ...(Object.hasOwn(repair, 'fromActions') ? ['fromActions'] : []),
      ...(Object.hasOwn(repair, 'resumeCleanup') ? ['resumeCleanup'] : [])]) && identifier(repair.id) && !seen.has(repair.id));
    seen.add(repair.id);
    requireRepair(typeof repair.name === 'string' && repair.name.trim().length > 0 && repair.name.length <= 80 && !/[\x00-\x1f]/.test(repair.name));
    requireRepair(Array.isArray(repair.fromErrorCodes) && repair.fromErrorCodes.length > 0 && repair.fromErrorCodes.length <= 32 &&
      new Set(repair.fromErrorCodes).size === repair.fromErrorCodes.length && repair.fromErrorCodes.every(errorCode));
    requireRepair(Array.isArray(repair.secretNames) && new Set(repair.secretNames).size === repair.secretNames.length &&
      repair.secretNames.every(name => manifest.secrets.includes(name)));
    const actions = repairActions(repair);
    requireRepair(Array.isArray(actions) && actions.length > 0 && new Set(actions).size === actions.length &&
      actions.every(action => ['deploy', 'update', 'repair', 'preview', 'destroy-preview'].includes(action)));
    requireRepair(!actions.includes('destroy-preview') || actions.every(action => ['destroy-preview', 'repair'].includes(action)));
    if (Object.hasOwn(repair, 'resumeCleanup')) requireRepair(repair.resumeCleanup === true && actions.includes('destroy-preview'));
  }
}

export function validateRepairContext(request, manifest, compareVersions) {
  const value = request.context;
  requireRepair(exact(value, ['repairId', 'parentTaskId', 'parentRunId', 'requestDigest', 'resultDigest', 'errorCode', ...(repairedPreview(request) ? ['preview'] : []),
    ...(Object.hasOwn(value, 'previewBaseline') ? ['previewBaseline'] : []), ...(repairedCleanup(request) ? ['cleanup'] : []),
    ...(Object.hasOwn(value, 'cleanupProgress') ? ['cleanupProgress'] : [])]));
  requireRepair(identifier(value.repairId) && typeof value.parentTaskId === 'string' && /^dc-[a-f0-9]{32}$/.test(value.parentTaskId) && value.parentTaskId !== request.taskId &&
    Number.isSafeInteger(value.parentRunId) && value.parentRunId > 0 && digest(value.requestDigest) && digest(value.resultDigest) && errorCode(value.errorCode));
  const repair = manifest.repairs?.find(row => row.id === value.repairId);
  requireRepair(repair && repair.fromErrorCodes.includes(value.errorCode));
  if (repairedCleanup(request)) {
    requireRepair(repairActions(repair).includes('destroy-preview'));
    validateCleanupRepairContext(request, compareVersions);
    if (Object.hasOwn(value, 'cleanupProgress')) { requireRepair(repair.resumeCleanup === true); validateCleanupProgress(request); }
    requireRepair(new TextEncoder().encode(JSON.stringify(request)).length <= 49152);
    return;
  }
  requireRepair(!repairActions(repair).includes('destroy-preview'));
  requireRepair(!Object.hasOwn(value, 'cleanupProgress'));
  if (repairedPreview(request)) {
    requireRepair(repairActions(repair).includes('preview'));
    validatePreviewContext(previewRepairRequest(request));
    requireRepair(![value.preview.source.instanceId, value.preview.source.taskId].includes(value.parentTaskId));
    requireRepair(![request.sourceSha, request.previous.sourceSha].includes(value.preview.source.sourceSha));
    if (Object.hasOwn(value, 'previewBaseline')) {
      const baseline = value.previewBaseline;
      requireRepair(exact(baseline, ['sourceSha', 'applicationVersion', 'instanceId']) && typeof baseline.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(baseline.sourceSha) &&
        typeof baseline.instanceId === 'string' && /^dc-[a-f0-9]{32}$/.test(baseline.instanceId) &&
        ![request.taskId, value.preview.source.instanceId, value.preview.source.taskId].includes(baseline.instanceId));
      requireRepair(![request.sourceSha, value.preview.source.sourceSha].includes(baseline.sourceSha) &&
        compareVersions(baseline.applicationVersion, request.previous.applicationVersion) <= 0 &&
        compareVersions(baseline.applicationVersion, value.preview.source.applicationVersion) > 0);
    }
  } else requireRepair(!Object.hasOwn(value, 'previewBaseline') && repairActions(repair).some(action => action !== 'preview'));
  requireRepair(new TextEncoder().encode(JSON.stringify(request)).length <= 49152);
}

export function validateRepairResult(value, request) {
  // 修复不能仅以发布命令退出或 HTTP 登录重定向认定成功。
  requireRepair(value.status !== 'deployed-unverified');
  if (repairedCleanup(request)) { validateCleanupRepairResult(value, request); return; }
  if (repairedPreview(request)) validatePreviewResult(value, previewRepairRequest(request));
  if (value.status === 'succeeded') {
    for (const id of ['repair-completed', 'data-preserved', 'unchanged-resources-verified', 'service-ready']) {
      requireRepair(value.checks.some(check => check.id === id && check.passed));
    }
  }
}
