import { readJson, readAnalytics } from './connections-provider.mjs';
import { validResourceId } from './resources.mjs';

const LIMIT = 1000, DAY = 86400000;
export const QUOTA_REVIEWED_AT = '2026-10-08';
const check = value => { if (!value) throw new Error('usage unavailable'); };
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const iso = value => new Date(value).toISOString();
const date = value => iso(value).slice(0, 10);
const identifier = (kind, id) => kind === 'worker' ? typeof id === 'string' && /^[A-Za-z0-9_-]{1,63}$/.test(id) : validResourceId(kind, id);

// Numeric inclusions come from dated official pricing, not from an entitlement's hard limit.
// Only an explicitly identified, non-contract account plan can select these rules.
export function publicPlan(subscriptions, product, now) {
  check(Array.isArray(subscriptions) && subscriptions.length <= 100);
  const rows = subscriptions.filter(row => row?.rate_plan?.scope === 'account' &&
    typeof row.rate_plan.id === 'string' && row.rate_plan.id.startsWith(product + '_') &&
    ['Paid', 'Provisioned', 'Trial'].includes(row.state));
  if (rows.length !== 1) return null;
  const row = rows[0], plan = row.rate_plan;
  if (row.state === 'Trial' || plan.is_contract !== false || plan.externally_managed !== false ||
      ![product + '_paid', product + '_free'].includes(plan.id)) return null;
  const start = Date.parse(row.current_period_start), end = Date.parse(row.current_period_end);
  return { id: plan.id, paid: plan.id.endsWith('_paid'),
    ...(Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end && end - start <= 32 * DAY ? { start, end } : {}) };
}

async function planFor(account, kind, token, transport, now) {
  try {
    const body = await readJson(`https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`, token, false, transport);
    check(body.success === true && (!body.result_info?.total_pages || body.result_info.total_pages <= 1));
    return publicPlan(body.result, kind === 'r2' ? 'r2' : 'workers', now);
  } catch { return null; }
}
function quota(plan, value) {
  return plan ? { value, source: 'public-plan', plan: plan.id, reviewedAt: QUOTA_REVIEWED_AT } : null;
}
function metric(id, label, unit, period, periodLabel, allowance = null, estimated = false) {
  return { id, label, unit, period, periodLabel, allowance, estimated };
}
async function query(account, token, transport, selection, type, start, end) {
  const body = await readAnalytics(`query ResourceUsage($account:string!,$start:${type}!,$end:${type}!){viewer{accounts(filter:{accountTag:$account}){${selection}}}}`,
    { account, start, end }, token, transport);
  check(body && (body.errors === null || body.errors === undefined || Array.isArray(body.errors) && body.errors.length === 0));
  const accounts = body.data?.viewer?.accounts;
  check(Array.isArray(accounts) && accounts.length === 1);
  const rows = accounts[0].samples;
  check(Array.isArray(rows) && rows.length <= LIMIT);
  return { rows, complete: rows.length < LIMIT };
}
function sample(value, observedAt, complete = true) {
  check(number(value)); return { value, observedAt, complete };
}

async function storage(account, kind, token, transport, now, plan) {
  const day = date(now), dataset = kind === 'd1' ? 'd1StorageAdaptiveGroups' : 'kvStorageAdaptiveGroups';
  const field = kind === 'd1' ? 'databaseSizeBytes' : 'byteCount', dimension = kind === 'd1' ? 'databaseId' : 'namespaceId';
  const definition = metric('storage', '存储 · 今日峰值', 'bytes', 'day-peak:' + day, day + ' UTC', quota(plan, kind === 'd1' ? 5e9 : 1e9));
  const result = await query(account, token, transport,
    `samples:${dataset}(limit:${LIMIT},filter:{date_geq:$start,date_leq:$end}){max{${field}} dimensions{date ${dimension}}}`,
    'Date', day, day);
  const samples = Object.create(null);
  for (const row of result.rows) {
    const id = row.dimensions?.[dimension]; check(identifier(kind, id) && row.dimensions.date === day && !Object.hasOwn(samples, id));
    samples[id] = { storage: sample(row.max?.[field], day, result.complete) };
  }
  return { metrics: [definition], samples, complete: result.complete };
}

async function workers(account, token, transport, now, plan) {
  const monthly = plan?.paid && plan.start !== undefined;
  const start = monthly ? plan.start : Date.parse(date(now) + 'T00:00:00Z');
  const period = monthly ? `billing:${iso(start)}/${iso(plan.end)}` : 'day:' + date(now);
  const allowance = monthly ? quota(plan, 1e7) : plan && !plan.paid ? quota(plan, 1e5) : null;
  const definition = metric('requests', monthly ? '请求 · 本账期' : '请求 · 今日', 'requests', period,
    monthly ? `${date(start)} — ${date(plan.end)} UTC` : date(now) + ' UTC', allowance, true);
  const samples = Object.create(null); let complete = true, hadSuccess = false, unattributed = 0;
  // Workers analytics bounds each query to one week; non-overlapping chunks prevent double counting.
  for (let from = start; from < now; from += 7 * DAY) {
    const to = Math.min(from + 7 * DAY, now);
    try {
      const result = await query(account, token, transport,
        `samples:workersInvocationsAdaptive(limit:${LIMIT},filter:{datetime_geq:$start,datetime_lt:$end}){sum{requests} dimensions{scriptName}}`,
        'Time', iso(from), iso(to));
      hadSuccess = true; complete &&= result.complete;
      for (const row of result.rows) {
        const id = row.dimensions?.scriptName;
        check(identifier('worker', id));
        const value = row.sum?.requests; check(number(value));
        // Cloudflare returns multiple __unknown__ groups for historical unattributed scripts.
        if (id === '__unknown__') { unattributed += value; check(number(unattributed)); continue; }
        samples[id] ??= {}; samples[id].requests = sample((samples[id].requests?.value ?? 0) + value, iso(now));
      }
    } catch { complete = false; }
  }
  check(hadSuccess);
  for (const item of Object.values(samples)) item.requests.complete = complete;
  return { metrics: [definition], samples, complete: complete && unattributed === 0, unattributed: { requests: unattributed } };
}

async function r2(account, token, transport, now, plan) {
  const day = date(now), start = iso(now - DAY), end = iso(now);
  const metrics = [metric('storage', '存储 · 最新采样', 'bytes', 'latest:' + day, day + ' UTC')];
  const samples = Object.create(null), omitted = {}; let complete = true, hadSuccess = false;
  try {
    const latest = await query(account, token, transport,
      `samples:r2StorageAdaptiveGroups(limit:${LIMIT},filter:{datetime_geq:$start,datetime_leq:$end},orderBy:[datetime_DESC]){max{payloadSize} dimensions{datetime bucketName storageClass}}`,
      'Time', start, end);
    complete &&= latest.complete; hadSuccess = true;
    const buckets = new Map();
    for (const row of latest.rows) {
      const { bucketName: id, storageClass, datetime } = row.dimensions ?? {};
      // EU/FedRAMP bucket IDs are a separate inventory; never attach them to a default bucket.
      if (typeof id === 'string' && id.includes('_')) { omitted.storage = true; continue; }
      check(identifier('r2', id) && ['Standard', 'InfrequentAccess'].includes(storageClass));
      const time = Date.parse(datetime); check(Number.isFinite(time) && time >= now - DAY && time <= now);
      const value = row.max?.payloadSize; check(number(value));
      const item = buckets.get(id) ?? {}; buckets.set(id, item);
      if (!item[storageClass] || time > item[storageClass].time) item[storageClass] = { value, time };
    }
    for (const [id, classes] of buckets) {
      const values = Object.values(classes), time = Math.min(...values.map(row => row.time));
      samples[id] = { storage: sample(values.reduce((sum, row) => sum + row.value, 0), iso(time), latest.complete && values.length === 2) };
    }
  } catch { complete = false; }
  if (plan?.start !== undefined) {
    const first = date(plan.start), last = date(now), days = Math.floor((Date.parse(last) - Date.parse(first)) / DAY) + 1;
    metrics.push(metric('standard-month', '标准存储 · 账期累计', 'byte-month', `billing:${iso(plan.start)}/${iso(plan.end)}`,
      `${first} — ${date(plan.end)} UTC`, quota(plan, 10e9), true));
    try {
      const daily = await query(account, token, transport,
        `samples:r2StorageAdaptiveGroups(limit:${LIMIT},filter:{datetime_geq:$start,datetime_leq:$end,storageClass:"Standard"}){max{payloadSize} dimensions{date bucketName}}`,
        'Time', iso(plan.start), end);
      hadSuccess = true; complete &&= daily.complete;
      const seen = new Set(), buckets = new Map();
      for (const row of daily.rows) {
        const { bucketName: id, date: dateValue } = row.dimensions ?? {};
        if (typeof id === 'string' && id.includes('_')) { omitted['standard-month'] = true; continue; }
        check(identifier('r2', id) && /^\d{4}-\d{2}-\d{2}$/.test(dateValue) && dateValue >= first && dateValue <= last);
        const key = id + '/' + dateValue; check(!seen.has(key)); seen.add(key);
        const value = row.max?.payloadSize; check(number(value));
        const entry = buckets.get(id) ?? { value: 0, days: 0 }; entry.value += value / 30; entry.days++; buckets.set(id, entry);
      }
      for (const [id, item] of buckets) {
        samples[id] ??= {}; samples[id]['standard-month'] = sample(item.value, end, daily.complete && item.days === days);
      }
    } catch { complete = false; }
  } else {
    metrics.push(metric('standard-month', '标准存储 · 账期累计', 'byte-month', 'billing:unknown', '账期未知', quota(plan, 10e9), true));
  }
  check(hadSuccess);
  // The account allowance is shared across jurisdictions, even when this inventory is default-only.
  return { metrics, samples, omitted, complete: complete && Object.keys(omitted).length === 0 };
}

export async function readResourceUsage(account, token, kind, transport = fetch, now = Date.now()) {
  check(/^[a-f0-9]{32}$/.test(account) && ['d1', 'kv', 'r2', 'worker'].includes(kind));
  const plan = await planFor(account, kind, token, transport, now);
  try {
    const result = kind === 'worker' ? await workers(account, token, transport, now, plan) :
      kind === 'r2' ? await r2(account, token, transport, now, plan) : await storage(account, kind, token, transport, now, plan);
    // DO RPC transports plain DTOs; keep the prototype-safe accumulator internal.
    return { ...result, samples: { ...result.samples }, plan: plan?.id ?? null, checkedAt: now, status: result.complete ? 'available' : 'partial' };
  } catch {
    return { metrics: [], samples: {}, complete: false, plan: plan?.id ?? null, checkedAt: now, status: 'unavailable' };
  }
}
