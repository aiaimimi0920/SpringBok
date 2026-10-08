export const resourceKinds = ['worker', 'd1', 'kv', 'r2', 'repository'];
export const resourceLabels = { worker: 'Workers', d1: 'D1', kv: 'KV', r2: 'R2', repository: 'GitHub 仓库' };
export const brandName = provider => provider === 'cloudflare' ? 'Cloudflare' : 'GitHub';
const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const sum = values => { const result = values.reduce((total, value) => total + value, 0); return validNumber(result) ? result : null; };
export function formatAmount(value, unit) {
  if (!validNumber(value)) return '—';
  if (unit === 'requests') return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' 次';
  const suffix = unit === 'byte-month' ? '-month' : '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let index = 0, amount = value;
  while (amount >= 1000 && index < units.length - 1) { amount /= 1000; index++; }
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' ' + units[index] + suffix;
}
export const metricKey = metric => JSON.stringify([metric.kind, metric.id, metric.unit, metric.period]);

// Aggregation always works from unique account scopes. Spare quota in one account
// cannot cancel another account's overage, and an unknown value never becomes zero.
export function aggregateMetrics(input) {
  const groups = new Map();
  for (const metric of input) {
    const key = metricKey(metric); if (!groups.has(key)) groups.set(key, new Map());
    for (const scope of metric.scopes) groups.get(key).set(scope.key, { ...scope, definition: metric });
  }
  return [...groups.values()].map(scopes => {
    const values = [...scopes.values()], definition = values[0].definition;
    const known = values.filter(row => validNumber(row.value)), quotas = values.filter(row => validNumber(row.allowance));
    const value = known.length ? sum(known.map(row => row.value)) : null;
    const allowance = quotas.length ? sum(quotas.map(row => row.allowance)) : null;
    const complete = values.every(row => row.complete && validNumber(row.value)) && value !== null;
    const quotaComplete = quotas.length === values.length && allowance !== null;
    const comparable = values.filter(row => validNumber(row.value) && validNumber(row.allowance));
    const excesses = comparable.map(row => Math.max(0, row.value - row.allowance));
    return { ...definition, scopes: values.map(({ definition: _, ...row }) => row), value, allowance, complete, quotaComplete,
      remaining: complete && quotaComplete ? sum(values.map(row => Math.max(0, row.allowance - row.value))) : null,
      excess: comparable.length ? sum(excesses) : null,
      overAccounts: comparable.filter(row => row.value > row.allowance).length,
      excessComplete: complete && quotaComplete,
      ratio: complete && quotaComplete && allowance > 0 ? Math.min(1, value / allowance) : null,
    };
  });
}
function fallback(kind) {
  return { id: kind === 'worker' ? 'requests' : 'storage', label: kind === 'worker' ? '请求' : '存储',
    unit: kind === 'worker' ? 'requests' : 'bytes', period: 'unknown', periodLabel: '时间未知', allowance: null };
}
function groupFor(account, kind, sources) {
  const items = new Map(), successful = sources.filter(source => source.usage?.status !== 'unavailable' && source.usage?.metrics?.length);
  successful.sort((a, b) => b.usage.checkedAt - a.usage.checkedAt);
  const usage = successful[0]?.usage;
  const definitions = kind === 'repository' ? [] : usage?.metrics ?? [fallback(kind)];
  const complete = sources.some(source => source.status === 'complete');
  for (const source of sources) for (const item of source.items) {
    const existing = items.get(item.id);
    if (!existing || existing.item.available === false && item.available !== false) items.set(item.id, { item, source });
  }
  const budgets = sources.map(source => source.usage?.budget).filter(Boolean).sort((a, b) => b.revision - a.revision);
  const budget = budgets[0] ?? { revision: 0, value: null };
  const baseMetrics = definitions.map(definition => {
    let count = 0; const values = []; let samplesComplete = true;
    for (const [id, item] of items) {
      const candidates = successful.filter(source => source.usage.metrics.some(metric => metric.id === definition.id && metric.period === definition.period));
      const candidate = candidates.map(source => source.usage.samples[id]?.[definition.id]).filter(sample => validNumber(sample?.value))
        .sort((a, b) => Number(b.complete) - Number(a.complete) || String(b.observedAt).localeCompare(String(a.observedAt)))[0];
      item.metrics ??= []; item.metrics.push({ ...definition, value: candidate?.value ?? null, complete: candidate?.complete === true, observedAt: candidate?.observedAt });
      if (candidate) { values.push(candidate.value); count++; } else samplesComplete = false;
      samplesComplete &&= candidate?.complete === true;
    }
    const extra = successful.some(source => source.usage.omitted?.[definition.id] || source.usage.unattributed?.[definition.id] > 0 ||
      Object.entries(source.usage.samples).some(([id, metrics]) => metrics[definition.id] && !items.has(id)));
    const empty = complete && items.size === 0 && usage?.complete === true && !extra;
    return { ...definition, kind, scopes: [{ key: account.key + '/' + kind + '/' + definition.id + '/' + definition.period,
      value: count ? sum(values) : empty ? 0 : null, complete: complete && samplesComplete && !extra && (items.size > 0 || empty),
      allowance: validNumber(definition.allowance?.value) ? definition.allowance.value : null,
      source: definition.allowance?.source ?? null, accountKey: account.key }] };
  });
  const capacity = baseMetrics.find(metric => metric.id === 'storage');
  if (capacity && validNumber(budget.value)) baseMetrics.push({ ...capacity, id: 'planning-storage', label: '规划容量',
    allowance: { value: budget.value, source: 'manual' },
    scopes: capacity.scopes.map(scope => ({ ...scope, key: scope.key + '/planning', allowance: budget.value, source: 'manual' })) });
  const readySource = sources.find(source => source.row.state === 'verified');
  const status = complete ? '' : sources.some(source => source.status === 'loading') ? '正在读取…' :
    sources.some(source => source.next) ? '列表不完整' : sources.some(source => source.status === 'disabled') ? '账户连接不可用' : '读取失败';
  return { key: account.key + '/' + kind, kind, account, sources, items: [...items.values()], metrics: aggregateMetrics(baseMetrics),
    complete, status, budget, readySource, usageStatus: kind !== 'repository' && !usage ? '用量未提供' : '',
    more: sources.filter(source => source.next), checkedAt: usage?.checkedAt ?? null };
}
export function projectAccounts(sources) {
  const accounts = new Map();
  for (const source of sources) {
    const row = source.row, key = row.provider + '/' + row.target.toLowerCase();
    if (!accounts.has(key)) accounts.set(key, { key, provider: row.provider, target: row.target, name: row.accountName || row.target, note: row.name, sources: [] });
    accounts.get(key).sources.push(source);
  }
  return [...accounts.values()].map(account => {
    account.groups = resourceKinds.filter(kind => account.sources.some(source => source.kind === kind))
      .map(kind => groupFor(account, kind, account.sources.filter(source => source.kind === kind)));
    account.metrics = aggregateMetrics(account.groups.flatMap(group => group.metrics));
    account.count = account.groups.reduce((count, group) => count + group.items.length, 0);
    return account;
  });
}
export function resourceCount(groups) {
  return new Set(groups.flatMap(group => group.items.map(({ item }) => group.kind === 'repository' ?
    'github/' + item.id.toLowerCase() : group.account.key + '/' + group.kind + '/' + item.id))).size;
}
