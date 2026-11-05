import test from 'node:test';
import assert from 'node:assert/strict';
import { readEmailRouting, unbindEmailRouting } from '../cloud/email-routing-provider.mjs';
import { inspectDeletionEmail, deletionEmailAbsent } from '../cloud/service-deletion-email.mjs';

const accountId = 'a'.repeat(32), zoneId = 'e'.repeat(32), worker = 'test-worker';
const target = { kind: 'email-routing', accountId, zoneId, domain: 'example.invalid', remoteId: 'email-routing:' + zoneId, name: 'example.invalid', worker };
const workerRow = { kind: 'worker', accountId, remoteId: worker, name: worker };
function provider() {
  const state = { calls: [], success: true, rule: { id: 'f'.repeat(32), source: 'api', name: 'Mail', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }] } };
  const transport = async (url, options) => {
    const u = new URL(url); state.calls.push({ path: u.pathname, method: options.method });
    const ok = result => Response.json({ success: true, result });
    if (u.pathname.endsWith('/catch_all')) {
      if (options.method === 'PUT') { state.rule = { ...state.rule, ...JSON.parse(options.body) }; return Response.json({ success: state.success, result: state.rule }); }
      return ok(state.rule);
    }
    if (u.pathname.endsWith('/email/routing/rules')) {
      if (state.list) return state.list(u);
      return Response.json({ success: true, result: [{ ...state.rule, zone: { tag: zoneId, name: target.domain } }], result_info: { page: 1, count: 1, total_count: 1 } });
    }
    if (u.pathname.endsWith('/email/routing')) return ok({ id: zoneId, name: target.domain, enabled: true, status: 'ready' });
    return ok({ id: zoneId, name: target.domain, status: 'active', account: { id: accountId } });
  };
  return { state, transport };
}
test('undeclared catch-all or literal references block Worker-only deletion, even with no email target', async () => {
  const { state, transport } = provider();
  await assert.rejects(inspectDeletionEmail([workerRow], 'synthetic', transport));
  state.rule.matchers = [{ type: 'literal', field: 'to', value: 'private@example.invalid' }];
  await assert.rejects(inspectDeletionEmail([workerRow], 'synthetic', transport));
  assert.ok(state.calls.every(row => row.method === 'GET'));
});
test('account-wide email reference scan proves every page and rejects incomplete, duplicate, excessive or hidden references', async () => {
  const { state, transport } = provider();
  const rules = Array.from({ length: 51 }, (_, i) => ({ id: i.toString(16).padStart(32, '0'), actions: [{ type: 'drop' }] }));
  state.list = u => {
    const page = Number(u.searchParams.get('page')), result = rules.slice((page - 1) * 50, page * 50);
    return Response.json({ success: true, result, result_info: { page, count: result.length, total_count: rules.length } });
  };
  assert.deepEqual(await inspectDeletionEmail([workerRow], 'synthetic', transport), []);
  rules[50].actions = [{ type: 'worker', value: [worker] }]; await assert.rejects(inspectDeletionEmail([workerRow], 'synthetic', transport));
  rules[50].actions = [{ type: 'drop' }]; rules[50].id = rules[0].id; await assert.rejects(inspectDeletionEmail([workerRow], 'synthetic', transport));
  for (const info of [{ page: 1, count: 0, total_count: 1 }, { page: 1, count: 0, total_count: 1001 }, { page: 1, count: 0 }, null]) {
    state.list = () => Response.json({ success: true, result: [], result_info: info });
    await assert.rejects(inspectDeletionEmail([workerRow], 'synthetic', transport));
  }
  state.list = () => Response.json({ success: false, errors: [{ code: 10000 }], result: null }, { status: 403 });
  await assert.rejects(inspectDeletionEmail([workerRow], 'synthetic', transport));
});
test('unbind validates exact snapshot and success body; rejected mutation is never retried; late mail references prevent absence', async () => {
  const { state, transport } = provider(), row = { ...target, rule: await readEmailRouting(target, 'synthetic', transport) };
  state.rule.name = 'Changed'; await assert.rejects(unbindEmailRouting(row, 'synthetic', transport));
  assert.ok(state.calls.every(row => row.method === 'GET')); state.rule.name = 'Mail'; state.success = false;
  await assert.rejects(unbindEmailRouting(row, 'synthetic', transport));
  assert.equal(state.calls.filter(row => row.method === 'PUT').length, 1);
  assert.equal(await deletionEmailAbsent(row, 'synthetic', transport), true);
  state.list = () => Response.json({ success: true, result: [{ id: '1'.repeat(32), actions: [{ type: 'worker', value: [worker] }] }], result_info: { page: 1, count: 1, total_count: 1 } });
  assert.equal(await deletionEmailAbsent(row, 'synthetic', transport), false);
});
