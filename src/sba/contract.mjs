// 平台仅校验并调用应用契约，不解释迁移或业务实现。
import { PREVIEW_ACTIONS, previewAction, validatePreviewContext, validatePreviewResult } from './preview.mjs';
import { validateRepairs, validateRepairContext, validateRepairResult } from './repair.mjs';
export class SbaContractError extends Error {}
const fail = message => { throw new SbaContractError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid contract fields');
};
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const SBA_ACTIONS = Object.freeze(['deploy', 'update', 'verify']);
const reservedEnvironment = /^(?:GITHUB_|ACTIONS_|RUNNER_|SBA_|GIT_|NODE_|NPM_|PYTHON|DOTNET_)|^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|COMMONPROGRAMFILES|TEMP|TMP|TMPDIR|CI|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PSMODULEPATH|ENV|BASH_ENV)$/;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) fail('stable x.y.z version required');
  return value.split('.').map(Number);
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function validateManifest(value) {
  exact(value, ['schemaVersion', 'id', 'name', 'version', 'entrypoint', 'runtime', 'actions', 'secrets'], ['repairs']);
  if (![2, 3].includes(value.schemaVersion)) fail('unsupported SBA schema; migrate v1 explicitly');
  if (!identifier(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f]/.test(value.name)) fail('invalid application identity');
  versionParts(value.version);
  // 入口相对 .sba；文件存在、符号链接和解析后边界由执行端另行检查。
  if (typeof value.entrypoint !== 'string' || !/^[a-zA-Z0-9_-]+\.ps1$/.test(value.entrypoint)) fail('entrypoint must be a .sba PowerShell file');
  exact(value.runtime, ['runner', 'powershell', 'python', 'node']);
  if (value.runtime.runner !== 'windows-2025' || value.runtime.powershell !== '5.1' ||
      value.runtime.python !== '3.12' || value.runtime.node !== '22') fail('unsupported SBA runtime');
  const actions = value.schemaVersion === 3 ? [...SBA_ACTIONS, ...PREVIEW_ACTIONS, ...(object(value.actions) && Object.hasOwn(value.actions, 'repair') ? ['repair'] : [])] : SBA_ACTIONS;
  exact(value.actions, actions);
  for (const action of actions) {
    exact(value.actions[action], ['timeoutSeconds']);
    const timeout = value.actions[action].timeoutSeconds;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) fail('invalid action timeout');
  }
  if (!Array.isArray(value.secrets) || value.secrets.length > 20 || new Set(value.secrets).size !== value.secrets.length ||
      value.secrets.some(name => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || reservedEnvironment.test(name))) fail('invalid secret references');
  validateRepairs(value);
  return structuredClone(value);
}

export function validateRequest(value, manifest) {
  const app = validateManifest(manifest);
  exact(value, ['schemaVersion', 'taskId', 'action', 'repository', 'sourceSha', 'applicationId', 'applicationVersion', 'environment', 'configuration', 'previous', ...(previewAction(value.action) || value.action === 'repair' ? ['context'] : [])]);
  if (value.schemaVersion !== app.schemaVersion || !identifier(value.taskId) || !Object.hasOwn(app.actions, value.action) ||
      typeof value.repository !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.repository) ||
      !sha(value.sourceSha) || !identifier(value.environment)) fail('invalid execution identity');
  if (value.applicationId !== app.id || value.applicationVersion !== app.version) fail('application identity mismatch');
  if (!object(value.configuration) || JSON.stringify(value.configuration).length > 32768) fail('invalid public configuration');
  // 平台没有业务 schema；secret 值不可混入 configuration，由部署配置入口另行约束。
  if (value.action === 'deploy') {
    if (value.previous !== null) fail('deploy requires no previous release');
  } else {
    exact(value.previous, ['sourceSha', 'applicationVersion']);
    if (!sha(value.previous.sourceSha)) fail('invalid previous release');
    const comparison = compareVersions(value.applicationVersion, value.previous.applicationVersion);
    if (['update', 'preview', 'repair'].includes(value.action) && (comparison <= 0 || value.sourceSha === value.previous.sourceSha)) fail('update or repair requires a newer version and different SHA');
    if (['verify', 'destroy-preview'].includes(value.action) && (comparison !== 0 || value.sourceSha !== value.previous.sourceSha)) fail('verify requires the selected deployed release');
  }
  if (previewAction(value.action)) validatePreviewContext(value);
  if (value.action === 'repair') validateRepairContext(value, app);
  return structuredClone(value);
}

export function validateResult(value, request) {
  exact(value, ['schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion', 'status', 'checks'], ['errorCode', ...(previewAction(request.action) ? ['lifecycle'] : [])]);
  for (const key of ['schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion']) {
    if (value[key] !== request[key]) fail('result identity mismatch');
  }
  if (!['succeeded', 'deployed-unverified', 'failed', 'unknown'].includes(value.status)) fail('invalid result status');
  if (request.action === 'verify' && value.status === 'deployed-unverified') fail('verify cannot return an unverified deployment');
  if (!Array.isArray(value.checks) || value.checks.length > 30 || new Set(value.checks.map(item => item?.id)).size !== value.checks.length) fail('invalid checks');
  for (const check of value.checks) {
    exact(check, ['id', 'passed']);
    if (!identifier(check.id) || typeof check.passed !== 'boolean') fail('invalid check');
  }
  if (value.status === 'succeeded' && (!value.checks.length || value.checks.some(check => !check.passed))) fail('success requires passing application checks');
  if (request.schemaVersion === 3 && request.action === 'update' && ['succeeded', 'deployed-unverified'].includes(value.status)) {
    for (const id of ['backup-created', 'data-preserved']) if (!value.checks.some(check => check.id === id && check.passed)) fail('update requires backup and data preservation checks');
  }
  if (Object.hasOwn(value, 'errorCode') && (typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,79}$/.test(value.errorCode))) fail('invalid error code');
  if (previewAction(request.action)) validatePreviewResult(value, request);
  if (request.action === 'repair') validateRepairResult(value);
  return structuredClone(value);
}
