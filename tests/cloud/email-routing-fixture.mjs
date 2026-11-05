import { previewFixture, configurePreviewFixture } from './preview-fixture.mjs';

export const zoneId = 'e'.repeat(32), ruleId = 'f'.repeat(32);
export async function emailRoutingFixture(fixture = null) {
  const s = fixture ? configurePreviewFixture(fixture) : await previewFixture(), prior = s.state.provider;
  const d = s.state.declaration;
  d.defaults.routing = null;
  d.fields.push({ path: ['routing'], label: '邮件路由', type: 'json', required: false, template: null });
  d.targets.push({ kind: 'email-routing', path: ['routing'], account: 'runtime', workerPath: ['server', 'name'] });
  s.input.environment = 'test'; s.input.values.routing = { zoneId, domain: 'example.invalid' };
  const live = {
    zoneAccount: 'a'.repeat(32), zoneName: 'example.invalid', ready: true, lost: false, writes: [], extraRules: [],
    rule: { id: ruleId, source: 'api', name: 'Original rule', enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] },
  };
  const routePath = `/client/v4/zones/${zoneId}/email/routing/rules/catch_all`;
  s.state.provider = async (request, context) => {
    const url = new URL(request.url), ok = result => Response.json({ success: true, result });
    if (url.origin !== 'https://api.cloudflare.com') return prior(request, context);
    if (request.method !== 'GET') live.writes.push({ method: request.method, path: url.pathname });
    if (url.pathname === routePath && request.method === 'PUT') {
      live.rule = { ...live.rule, ...await request.json() };
      return live.lost ? new Response(null, { status: 503 }) : ok(live.rule);
    }
    if (request.method === 'GET') {
      if (url.pathname === `/client/v4/zones/${zoneId}`) return ok({ id: zoneId, name: live.zoneName, status: 'active', account: { id: live.zoneAccount } });
      if (url.pathname === `/client/v4/zones/${zoneId}/email/routing`) return ok({ id: zoneId, name: live.zoneName, enabled: live.ready, status: live.ready ? 'ready' : 'unconfigured' });
      if (url.pathname === routePath) return ok(live.rule);
      if (url.pathname.endsWith('/email/routing/rules')) {
        const rows = [{ ...live.rule, zone: { tag: zoneId, name: live.zoneName } }, ...live.extraRules];
        return Response.json({ success: true, result: rows, result_info: { page: 1, per_page: 50, count: rows.length, total_count: rows.length } });
      }
    }
    return prior(request, context);
  };
  const activate = () => { live.rule.enabled = true; live.rule.actions = [{ type: 'worker', value: ['test-worker'] }]; };
  const deploy = async () => {
    const response = await s.service('plan', s.input);
    if (response.status !== 200) throw new Error(response.text);
    const first = response.json(), submitted = await s.submit(first);
    if (submitted.status !== 200) throw new Error(submitted.text);
    activate(); s.complete(await (await s.machine()).json());
    await s.service('service-state', { instanceId: first.taskId, reconcile: true });
    Object.assign(s.resource, { remoteId: s.state.created[0].id, name: s.state.created[0].name });
    return first;
  };
  return { ...s, live, activate, deploy, routePath, mailRouting: true };
}
