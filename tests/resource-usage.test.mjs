import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publicPlan, readResourceUsage } from '../cloud/resource-usage.mjs';

const account = 'a'.repeat(32), now = Date.parse('2026-10-02T12:00:00Z'), database = '12345678-1234-1234-1234-123456789abc';
const subscriptions = product => [{ state: 'Paid', current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2026-11-01T00:00:00Z',
  rate_plan: { id: product + '_paid', scope: 'account', is_contract: false, externally_managed: false } }];
const response = rows => Response.json({ data: { viewer: { accounts: [{ samples: rows }] } }, errors: null });
test('UI-06 storage tests are wired into the explicit workerd CI entry', async () => {
  const manifest = JSON.parse(await readFile(new URL('./cloud/package.json', import.meta.url), 'utf8'));
  for (const file of ['resource-usage.test.mjs', 'admin-service-token.test.mjs', 'brand-resources.test.mjs'])
    assert.ok(manifest.scripts.test.split(' ').includes(file), file);
});
function transportFor(kind, records, options = {}) {
  const calls = [];
  const transport = async (url, request) => {
    calls.push({ url, request }); assert.equal(request.redirect, 'manual');
    if (url.endsWith('/subscriptions')) { assert.equal(request.method, 'GET'); return Response.json({ success: true, result: options.plans ?? subscriptions(kind === 'r2' ? 'r2' : 'workers') }); }
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql'); assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body); assert.equal(body.variables.account, account); assert.ok(body.query.startsWith('query ResourceUsage'));
    return records(body, calls);
  };
  return { transport, calls };
}
test('only an explicit standard account subscription selects dated public inclusions', () => {
  const plan = subscriptions('workers'); assert.equal(publicPlan(plan, 'workers', now).id, 'workers_paid');
  for (const changes of [{ scope: 'zone' }, { is_contract: true }, { externally_managed: true }, { id: 'workers_enterprise' }])
    assert.equal(publicPlan([{ ...plan[0], rate_plan: { ...plan[0].rate_plan, ...changes } }], 'workers', now), null);
  assert.equal(publicPlan([], 'workers', now), null);
  assert.equal(publicPlan([...plan, ...plan], 'workers', now), null);
  assert.equal(publicPlan([{ ...plan[0], state: 'Trial' }], 'workers', now), null);
});
test('D1 and KV retain units, day-peak semantics, unknowns and account-shared plan allowance', async () => {
  for (const kind of ['d1', 'kv']) {
    const id = kind === 'd1' ? database : '1'.repeat(32), field = kind === 'd1' ? 'databaseSizeBytes' : 'byteCount', dimension = kind === 'd1' ? 'databaseId' : 'namespaceId';
    const { transport, calls } = transportFor(kind, () => response([{ max: { [field]: 957e6 }, dimensions: { [dimension]: id, date: '2026-10-02' }, secret: 'must-not-return' }]));
    const result = await readResourceUsage(account, 'synthetic', kind, transport, now);
    assert.equal(result.status, 'available'); assert.equal(result.metrics[0].unit, 'bytes');
    assert.equal(result.metrics[0].period, 'day-peak:2026-10-02'); assert.equal(result.metrics[0].allowance.value, kind === 'd1' ? 5e9 : 1e9);
    assert.equal(result.samples[id].storage.value, 957e6); assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(result).includes('must-not-return')); assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
});
test('R2 snapshot bytes are separate from standard-only estimated GB-month and IA is not free', async () => {
  const { transport } = transportFor('r2', body => body.query.includes('storageClass:"Standard"') ? response([
    { max: { payloadSize: 957e6 }, dimensions: { bucketName: 'bucket-one', date: '2026-10-01' } },
    { max: { payloadSize: 957e6 }, dimensions: { bucketName: 'bucket-one', date: '2026-10-02' } },
    { max: { payloadSize: 1e12 }, dimensions: { bucketName: 'eu_bucket-one', date: '2026-10-02' } },
  ]) : response([
    { max: { payloadSize: 957e6 }, dimensions: { bucketName: 'bucket-one', datetime: '2026-10-02T11:00:00Z', storageClass: 'Standard' } },
    { max: { payloadSize: 10e6 }, dimensions: { bucketName: 'bucket-one', datetime: '2026-10-02T11:00:00Z', storageClass: 'InfrequentAccess' } },
    { max: { payloadSize: 1e12 }, dimensions: { bucketName: 'eu_bucket-one', datetime: '2026-10-02T11:00:00Z', storageClass: 'Standard' } },
  ]));
  const result = await readResourceUsage(account, 'synthetic', 'r2', transport, now);
  assert.equal(result.samples['bucket-one'].storage.value, 967e6);
  assert.equal(result.metrics[0].allowance, null);
  assert.equal(result.metrics[1].unit, 'byte-month'); assert.equal(result.metrics[1].allowance.value, 10e9);
  assert.equal(result.samples['bucket-one']['standard-month'].value, 957e6 * 2 / 30);
  assert.equal(result.metrics[1].estimated, true); assert.equal(result.samples['eu_bucket-one'], undefined);
  assert.equal(result.status, 'partial'); assert.equal(result.omitted['standard-month'], true);
});
test('Workers requests use nonoverlapping bounded billing windows; provider names cannot mutate prototypes', async () => {
  const late = Date.parse('2026-10-23T12:00:00Z'), ranges = [];
  const { transport } = transportFor('worker', body => {
    assert.match(body.query, /datetime_lt:\$end/); ranges.push(body.variables);
    return response([{ dimensions: { scriptName: '__proto__' }, sum: { requests: 12 } }]);
  });
  const result = await readResourceUsage(account, 'synthetic', 'worker', transport, late);
  assert.equal(ranges.length, 4); assert.equal(result.samples.__proto__.requests.value, 48); assert.equal(Object.prototype.requests, undefined);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i - 1].end);
  assert.equal(result.metrics[0].allowance.value, 1e7); assert.equal(result.metrics[0].period, 'billing:2026-10-01T00:00:00.000Z/2026-11-01T00:00:00.000Z');
});
test('missing plans, empty analytics, malformed values, partial GraphQL errors and redirects never fabricate usage', async () => {
  const empty = transportFor('d1', () => response([]), { plans: [] });
  const result = await readResourceUsage(account, 'synthetic', 'd1', empty.transport, now);
  assert.equal(result.metrics[0].allowance, null); assert.deepEqual(Object.keys(result.samples), []);
  for (const reply of [
    () => Response.json({ errors: [{ message: 'synthetic secret error' }], data: { viewer: { accounts: [{ samples: [] }] } } }),
    () => response([{ dimensions: { databaseId: database, date: '2026-10-02' }, max: { databaseSizeBytes: -1 } }]),
    () => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
  ]) {
    const { transport } = transportFor('d1', reply); const failed = await readResourceUsage(account, 'synthetic', 'd1', transport, now);
    assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.samples, {}); assert.ok(!JSON.stringify(failed).includes('secret error'));
  }
  await assert.rejects(readResourceUsage('../other', 'synthetic', 'd1', empty.transport, now));
});
test('Workers historical unknown groups remain unattributed without discarding later valid resources', async () => {
  const { transport } = transportFor('worker', () => response([
    { dimensions: { scriptName: '__unknown__' }, sum: { requests: 10 } },
    { dimensions: { scriptName: '__unknown__' }, sum: { requests: 12 } },
    { dimensions: { scriptName: 'current-worker' }, sum: { requests: 31 } },
  ]));
  const result = await readResourceUsage(account, 'synthetic', 'worker', transport, now);
  assert.equal(result.status, 'partial'); assert.equal(result.unattributed.requests, 22);
  assert.equal(result.samples['current-worker'].requests.value, 31); assert.equal(result.samples.__unknown__, undefined);
});
