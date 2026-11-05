import { readJson } from './connections-provider.mjs';
import { requireSba, canonicalSba } from './sba-control.mjs';

const endpoint = (zone, suffix = '') => `https://api.cloudflare.com/client/v4/zones/${zone}${suffix}`;
const check = (condition, code) => { if (!condition) throw new Error(code); };
export const neutralEmailRule = rule => rule.enabled === false && rule.actions.length === 1 && rule.actions[0].type === 'drop';
export const ownsEmailRule = (rule, worker) => rule.actions.length === 1 && rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 && rule.actions[0].value[0] === worker;
export function emailRule(value) {
  requireSba(value && /^[a-f0-9]{32}$/.test(value.id) && value.source === 'api' && typeof value.enabled === 'boolean');
  requireSba(typeof value.name === 'string' && value.name.length <= 256 && !/[\x00-\x1f]/.test(value.name));
  requireSba(Array.isArray(value.matchers) && value.matchers.length === 1 && canonicalSba(value.matchers) === canonicalSba([{ type: 'all' }]));
  requireSba(Array.isArray(value.actions) && value.actions.length === 1);
  const action = value.actions[0]; requireSba(['drop', 'forward', 'worker'].includes(action.type));
  if (action.type === 'drop') requireSba(action.value === undefined || Array.isArray(action.value) && action.value.length === 0);
  else requireSba(Array.isArray(action.value) && action.value.length === 1 && typeof action.value[0] === 'string' && action.value[0].length > 0 && action.value[0].length <= 256);
  return { id: value.id, source: value.source, name: value.name, enabled: value.enabled, matchers: [{ type: 'all' }],
    actions: [action.type === 'drop' ? { type: 'drop' } : { type: action.type, value: [...action.value] }] };
}
export async function readEmailRouting(target, token, transport = fetch) {
  let zone, settings, rule;
  try {
    zone = await readJson(endpoint(target.zoneId), token, false, transport);
    settings = await readJson(endpoint(target.zoneId, '/email/routing'), token, false, transport);
    rule = await readJson(endpoint(target.zoneId, '/email/routing/rules/catch_all'), token, false, transport);
  } catch { throw new Error('email-routing-read-failed'); }
  check(zone.success === true && zone.result?.id === target.zoneId && zone.result.name === target.domain && zone.result.status === 'active' && zone.result.account?.id === target.accountId, 'email-routing-zone-mismatch');
  check(settings.success === true && settings.result?.id === target.zoneId && settings.result.name === target.domain && settings.result.enabled === true && settings.result.status === 'ready', 'email-routing-not-ready');
  check(rule.success === true, 'email-routing-read-failed');
  try { return emailRule(rule.result); } catch { throw new Error('email-routing-rule-unsupported'); }
}
// Only used inside the persisted single-attempt deletion lifecycle. Never changes
// shared Email Routing DNS/settings, never retries, and never follows redirects.
export async function unbindEmailRouting(row, token, transport = fetch) {
  const before = await readEmailRouting(row, token, transport);
  requireSba(ownsEmailRule(before, row.worker) && canonicalSba(before) === canonicalSba(row.rule));
  const result = await readJson(endpoint(row.zoneId, '/email/routing/rules/catch_all'), token, false, (url, options) => transport(url, {
    ...options, method: 'PUT', headers: { ...options.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: before.name, source: 'api', enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] }),
  }));
  // A 2xx alone is not an acknowledged mutation; require a matching body and
  // an independent GET before deleting its receiving Worker.
  const rule = emailRule(result.result);
  requireSba(result.success === true && rule.id === before.id && rule.name === before.name && neutralEmailRule(rule));
}
