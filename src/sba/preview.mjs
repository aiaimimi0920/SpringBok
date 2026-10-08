// SBA v3 生命周期合同：资源清单是执行边界，不是账户级凭据的沙箱。
const requireValue = value => { if (!value) throw new Error('SBA_PREVIEW_INVALID'); };
const exact = (value, keys) => requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
const task = value => typeof value === 'string' && /^dc-[a-f0-9]{32}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const PREVIEW_ACTIONS = Object.freeze(['preview', 'destroy-preview']);
export const previewAction = action => PREVIEW_ACTIONS.includes(action);
export function previewUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.port; } catch { return false; }
}
export const resourceIdentity = row => `${row.accountId}/${row.kind}/${row.remoteId}`;
export function validatePreviewInventory(rows) {
  requireValue(Array.isArray(rows) && rows.length > 0 && rows.length <= 20);
  for (const row of rows) {
    exact(row, ['key', 'kind', 'accountId', 'remoteId', 'name']);
    requireValue(typeof row.key === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(row.key) && /^[a-f0-9]{32}$/.test(row.accountId));
    requireValue(typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 256 && !/[\x00-\x1f]/.test(row.name));
    requireValue(typeof row.remoteId === 'string' && (row.kind === 'd1' ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.remoteId) :
      row.kind === 'kv' ? /^[a-f0-9]{32}$/.test(row.remoteId) : ['worker', 'r2'].includes(row.kind) ? /^[a-z][a-z0-9-]{1,62}$/.test(row.remoteId) : row.kind === 'domain' && previewUrl(row.remoteId)));
  }
  requireValue(new Set(rows.map(row => row.key)).size === rows.length && new Set(rows.map(resourceIdentity)).size === rows.length);
  return rows;
}
export function validatePreviewContext(request) {
  const context = request.context;
  if (request.action === 'preview') {
    exact(context, ['source', 'resources', 'urls']);
    const source = context.source;
    exact(source, ['instanceId', 'taskId', 'sourceSha', 'applicationVersion', 'environment', 'configuration', 'resources', 'resultDigest']);
    requireValue(task(source.instanceId) && task(source.taskId) && digest(source.resultDigest) && source.sourceSha === request.previous.sourceSha && source.applicationVersion === request.previous.applicationVersion);
    requireValue(typeof source.environment === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(source.environment) && source.environment !== request.environment);
    requireValue(source.configuration && typeof source.configuration === 'object' && !Array.isArray(source.configuration) && JSON.stringify(source.configuration).length <= 32768);
    validatePreviewInventory(source.resources); validatePreviewInventory(context.resources);
    const originals = new Set(source.resources.map(resourceIdentity));
    requireValue(context.resources.every(row => !originals.has(resourceIdentity(row))));
    requireValue(Array.isArray(context.urls) && context.urls.length > 0 && context.urls.length <= 8 && new Set(context.urls).size === context.urls.length && context.urls.every(url => previewUrl(url) && context.resources.some(row => row.kind === 'domain' && row.remoteId === url)));
  } else {
    exact(context, ['instanceId', 'previewTaskId', 'resultDigest', 'resources']);
    requireValue(task(context.instanceId) && task(context.previewTaskId) && digest(context.resultDigest));
    validatePreviewInventory(context.resources);
  }
  requireValue(new TextEncoder().encode(JSON.stringify(request)).length <= 49152);
}
export function validatePreviewResult(value, request) {
  const success = ['succeeded', 'deployed-unverified'].includes(value.status);
  if (!Object.hasOwn(value, 'lifecycle')) { requireValue(!success); return; }
  const result = value.lifecycle, preview = request.action === 'preview';
  exact(result, preview ? ['resources', 'urls', 'snapshot'] : ['resources']);
  requireValue(Array.isArray(result.resources) && result.resources.length === request.context.resources.length);
  const keys = request.context.resources.map(row => row.key), statuses = preview ? ['created', 'absent', 'unknown'] : ['removed', 'absent', 'failed', 'unknown'];
  requireValue(new Set(result.resources.map(row => row.key)).size === keys.length);
  for (const row of result.resources) { exact(row, ['key', 'status']); requireValue(keys.includes(row.key) && statuses.includes(row.status)); }
  if (preview) {
    requireValue(Array.isArray(result.urls) && result.urls.every(url => request.context.urls.includes(url)) && new Set(result.urls).size === result.urls.length);
    if (result.snapshot !== null) { exact(result.snapshot, ['id', 'createdAt']); requireValue(digest(result.snapshot.id) && Number.isSafeInteger(result.snapshot.createdAt) && result.snapshot.createdAt > 0); }
    if (success) {
      requireValue(result.snapshot !== null && result.urls.length === request.context.urls.length && result.resources.every(row => row.status === 'created'));
      for (const id of ['snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated']) requireValue(value.checks.some(row => row.id === id && row.passed));
    }
  } else if (success) requireValue(value.status === 'succeeded' && result.resources.every(row => ['removed', 'absent'].includes(row.status)));
}
