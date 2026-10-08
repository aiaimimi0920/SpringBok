import { formatAmount, resourceLabels } from './resource-model.mjs';

export const statusText = status => ({
  loading: '正在读取', submitting: '正在提交', dispatching: '正在派发', dispatched: '等待执行',
  'dispatch-unknown': '派发未确认', running: '部署中', succeeded: '部署成功',
  'deployed-unverified': '已部署，待验证', failed: '部署失败', unknown: '结果未确认',
  'preparation-unconfirmed': '准备未确认', unavailable: '读取失败', imported: '已导入', deleted: '已删除',
}[status] ?? '状态未知');
export const statusTone = status => status === 'succeeded' ? 'success' : status === 'failed' || status === 'unavailable' ? 'error' :
  ['unknown', 'dispatch-unknown', 'deployed-unverified', 'preparation-unconfirmed'].includes(status) ? 'warning' : 'info';
export const valueAt = (root, path) => path.reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, root);
export function newerVersion(next, previous) {
  const valid = value => typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);
  if (!valid(next) || !valid(previous)) return false;
  const left = next.split('.').map(Number), right = previous.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
export function boundResources(instance) {
  const resources = Object.values(instance?.resources ?? {}).map(row => ({ kind: row.kind, id: row.remoteId, name: row.name, connectionId: row.connectionId ?? instance?.connections?.cloudflare?.id, accountId: row.accountId ?? instance?.accountId }));
  for (const target of instance?.targets ?? []) if (target.kind === 'worker') resources.push({ kind: 'worker', id: target.value, name: target.value, accountId: target.accountId ?? instance?.accountId,
    connectionId: Object.values(instance?.accounts ?? {}).find(account => account.accountId === target.accountId)?.connection.id ?? instance?.connections?.cloudflare?.id });
  return [...new Map(resources.map(row => [row.accountId + '/' + row.kind + '/' + row.id, row])).values()];
}
export function resourceMetrics(instance, resource, usage) {
  const connectionId = resource.connectionId ?? instance.connections?.cloudflare?.id;
  const source = connectionId ? usage.get(connectionId + '/' + resource.kind) : null;
  const fallback = { id: resource.kind === 'worker' ? 'requests' : 'storage', label: resource.kind === 'worker' ? '请求' : '存储', unit: resource.kind === 'worker' ? 'requests' : 'bytes', periodLabel: '时间未知' };
  return (source?.metrics?.length ? source.metrics : [fallback]).map(metric => {
    const sample = source?.samples?.[resource.id]?.[metric.id];
    return { label: metric.label, periodLabel: metric.periodLabel, observedAt: sample?.observedAt ?? null,
      text: formatAmount(sample?.value, metric.unit) + (sample?.value == null ? '' : !sample.complete ? ' · 部分' : metric.estimated ? ' · 估算' : '') };
  });
}
export function resourceCountText(instance) {
  const counts = new Map(); for (const row of boundResources(instance)) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${resourceLabels[kind]} ×${count}`).join(' · ') || '—';
}
export function confirmedVersion(state) {
  const job = state?.job, previous = state?.instance?.previous;
  if (['succeeded', 'deployed-unverified'].includes(job?.status)) return { version: job.request.applicationVersion, sourceSha: job.request.sourceSha };
  return previous ? { version: previous.applicationVersion, sourceSha: previous.sourceSha } : null;
}
