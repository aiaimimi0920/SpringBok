import { deploymentTargets } from './deployment-contract.mjs';

function strings(value) {
  return typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

// v2 声明中的资源及 target 是写入边界；issuer 等外部依赖不是占用身份。
// v1 保留历史保守检查，不用新声明语义重新解释旧合同。
export function deploymentIdentities(plan, accountId = null) {
  if (plan.application.declaration.schemaVersion !== 2) return [...new Set(strings(plan.configuration).filter(value => value.length <= 256))];
  const resources = Object.values(plan.resources).filter(row => !accountId || row.accountId === accountId);
  const targets = deploymentTargets(plan.application.declaration, plan.configuration).filter(row => !accountId || row.accountId === accountId);
  return [...new Set([...resources.flatMap(row => [row.name, row.remoteId]), ...targets.map(row => row.value)].filter(value => typeof value === 'string' && value.length > 0))];
}
