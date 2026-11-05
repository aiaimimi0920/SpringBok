import { readJson } from './connections-provider.mjs';
import { requireSba, canonicalSba } from './sba-control.mjs';
import { emailDomain, emailIdentity } from './deployment-email-targets.mjs';
import { readEmailRouting, ownsEmailRule, neutralEmailRule, emailRule } from './email-routing-provider.mjs';

export function deletionEmailTarget(target, instance) {
  requireSba(/^[a-f0-9]{32}$/.test(target.zoneId) && target.value === emailIdentity(target.zoneId) && emailDomain(target.domain));
  requireSba(instance.targets.some(row => row.kind === 'worker' && row.value === target.worker && row.accountId === target.accountId));
  return { kind: 'email-routing', accountId: target.accountId, remoteId: target.value, name: target.domain, zoneId: target.zoneId, domain: target.domain, worker: target.worker };
}
// The account-wide list includes catch-all and literal rules across zones. Do not
// publish other recipients, and never infer completeness from a short page.
async function accountRules(accountId, token, transport) {
  const rows = []; let total = null;
  for (let page = 1; page <= 20; page++) {
    const body = await readJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/rules?per_page=50&page=${page}`, token, false, transport);
    const info = body.result_info;
    requireSba(body.success === true && Array.isArray(body.result) && body.result.length <= 50 && info?.page === page && info.count === body.result.length && Number.isSafeInteger(info.total_count) && info.total_count >= 0 && info.total_count <= 1000);
    if (total === null) total = info.total_count;
    requireSba(total === info.total_count && (body.result.length > 0 || total === 0));
    rows.push(...body.result); requireSba(rows.length <= total);
    if (rows.length === total) {
      requireSba(new Set(rows.map(row => row.id)).size === rows.length);
      return rows;
    }
  }
  throw new Error('email-routing-list-incomplete');
}
export async function inspectDeletionEmail(rows, token, transport = fetch) {
  const routes = rows.filter(row => row.kind === 'email-routing');
  const selected = rows.filter(row => row.kind === 'worker');
  if (!selected.length) return [];
  const live = [];
  for (const row of routes) {
    const rule = await readEmailRouting(row, token, transport);
    requireSba(ownsEmailRule(rule, row.worker) || neutralEmailRule(rule));
    live.push({ ...row, present: !neutralEmailRule(rule), rule });
  }
  const rules = await accountRules(selected[0].accountId, token, transport);
  const workers = new Set(selected.map(row => row.remoteId));
  for (const rule of rules) {
    requireSba(Array.isArray(rule.actions) && rule.actions.length === 1 && ['worker', 'forward', 'drop'].includes(rule.actions[0].type));
    if (rule.actions[0].type !== 'worker') continue;
    requireSba(Array.isArray(rule.actions[0].value) && rule.actions[0].value.length === 1 && typeof rule.actions[0].value[0] === 'string');
    if (!workers.has(rule.actions[0].value[0])) continue;
    const owned = live.find(row => row.rule.id === rule.id && row.zoneId === rule.zone?.tag && row.domain === rule.zone?.name);
    requireSba(owned && canonicalSba(emailRule(rule)) === canonicalSba(owned.rule));
  }
  for (const row of live.filter(row => row.present)) requireSba(rules.some(rule => rule.id === row.rule.id && rule.zone?.tag === row.zoneId));
  return live;
}
export async function deletionEmailAbsent(row, token, transport = fetch) {
  const rule = await readEmailRouting(row, token, transport);
  if (rule.id !== row.rule.id || !neutralEmailRule(rule)) return false;
  const rules = await accountRules(row.accountId, token, transport);
  return rules.every(rule => Array.isArray(rule.actions) && rule.actions.length === 1 &&
    (rule.actions[0].type !== 'worker' || Array.isArray(rule.actions[0].value) && !rule.actions[0].value.includes(row.worker)));
}
