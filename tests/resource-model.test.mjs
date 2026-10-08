import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMetrics, projectAccounts, formatAmount, resourceCount } from '../public/cloud-admin/resource-model.mjs';
const metric = (account, value, allowance, changes = {}) => ({ kind: 'r2', id: 'storage', unit: 'bytes', period: 'same-day',
  scopes: [{ key: account, accountKey: account, value, allowance, complete: true, ...changes }] });
test('parent summaries deduplicate shared quota and retain per-account overages rather than netting balances', () => {
  const a = metric('a', 14e9, 10e9), b = metric('b', 1e9, 10e9);
  const [total] = aggregateMetrics([a, b, a]);
  assert.equal(total.value, 15e9); assert.equal(total.allowance, 20e9); assert.equal(total.remaining, 9e9);
  assert.equal(total.excess, 4e9); assert.equal(total.overAccounts, 1); assert.equal(total.ratio, .75);
  const [parent] = aggregateMetrics([total, a]); assert.equal(parent.allowance, 20e9); assert.equal(parent.excess, 4e9);
});
test('partial data, unknown quota and zero allowance have honest lower bounds and no fake available capacity', () => {
  const [unknown] = aggregateMetrics([metric('a', 14e9, 10e9), metric('b', null, 10e9, { complete: false })]);
  assert.equal(unknown.value, 14e9); assert.equal(unknown.complete, false); assert.equal(unknown.remaining, null); assert.equal(unknown.excess, 4e9); assert.equal(unknown.ratio, null);
  const [missingQuota] = aggregateMetrics([metric('a', 1, null)]); assert.equal(missingQuota.allowance, null); assert.equal(missingQuota.remaining, null);
  const [zero] = aggregateMetrics([metric('a', 1, 0)]); assert.equal(zero.excess, 1); assert.equal(zero.ratio, null);
  assert.equal(formatAmount(null, 'bytes'), '—'); assert.equal(formatAmount(957e6, 'bytes'), '957 MB');
  assert.equal(formatAmount(10e9, 'byte-month'), '10 GB-month');
});
test('different products, billing periods and units never collapse into one progress number', () => {
  const a = metric('a', 1, 10);
  assert.equal(aggregateMetrics([a, { ...a, kind: 'd1' }, { ...a, unit: 'requests' }, { ...a, period: 'different-cycle' }]).length, 4);
});
test('two views project the same instances; repeated account credentials do not multiply quota or planning values', () => {
  const make = id => ({ row: { id, provider: 'cloudflare', target: 'a'.repeat(32), name: '账户', state: 'verified' }, kind: 'd1', status: 'complete', next: '',
    items: [{ id: 'db', name: '业务', cursor: '' }], usage: { status: 'available', checkedAt: 1, complete: true, budget: { revision: 1, value: 8e9 },
      metrics: [{ id: 'storage', label: '存储', unit: 'bytes', period: 'same-day', allowance: { value: 5e9, source: 'public-plan' } }],
      samples: { db: { storage: { value: 2e9, complete: true, observedAt: '2026-10-08' } } } } });
  const [account] = projectAccounts([make('key-a'), make('key-b')]);
  assert.equal(account.groups.length, 1); assert.equal(account.count, 1); assert.equal(resourceCount(account.groups), 1);
  assert.equal(account.groups[0].metrics[0].allowance, 5e9); assert.equal(account.metrics[1].allowance, 8e9);
  assert.equal(account.groups[0].items[0].metrics[0].value, 2e9);
  const partial = make('key-c'); partial.usage.samples = {};
  assert.equal(projectAccounts([partial])[0].metrics[0].value, null);
  const omitted = make('key-d'); omitted.usage.omitted = { storage: true };
  assert.equal(projectAccounts([omitted])[0].metrics[0].remaining, null, 'Out-of-inventory usage cannot leave a certain account balance');
  const unattributed = make('key-e'); unattributed.usage.unattributed = { storage: 1 };
  assert.equal(projectAccounts([unattributed])[0].metrics[0].remaining, null);
});
