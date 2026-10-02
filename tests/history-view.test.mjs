import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRows, pageRows, eventRow } from '../public/test-console/history.mjs';
const input = (id, service = 'gateway') => ({ id, service, operation: 'test', params: {} });
const plan = { target: 'fixed-target', artifact: 'sha256:fixed' };
function fixture(count = 23) {
  const snapshot = { requests: [], history: [], preparationHistory: [] };
  for (let i = 1; i <= count; i++) {
    const value = input(`request-${i}`, i % 2 ? 'gateway' : 'forum');
    snapshot.requests.push({ input: value, status: i === count ? 'unknown' : 'accepted', plan, updateId: i === count ? undefined : `update-${i}` });
    snapshot.history.push({ revision: i, kind: 'intent', input: value, plan });
  }
  return snapshot;
}
test('history model is deterministic, paginated and never mutates snapshot', () => {
  const snapshot = fixture(), before = structuredClone(snapshot), rows = historyRows(snapshot);
  assert.deepEqual(historyRows(snapshot), rows); assert.deepEqual(snapshot, before);
  assert.equal(rows[0].id, 'request-23'); assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[1].status, 'accepted');
  assert.equal(pageRows(rows).rows.length, 10); assert.equal(pageRows(rows, 'all', 2).rows[0].id, 'request-13');
  assert.equal(pageRows(rows, 'all', 3).rows.length, 3); assert.equal(pageRows(rows, 'all', 999).page, 3);
  assert.equal(pageRows(rows, 'all', -1).page, 1); assert.equal(pageRows(rows, 'all', NaN).page, 1);
  assert.equal(pageRows(rows, 'gateway').total, 12); assert.equal(pageRows(rows, 'game').total, 0);
  assert.deepEqual(pageRows([]), { page: 1, pages: 1, total: 0, rows: [] });
  assert.throws(() => pageRows(rows, '__proto__'));
});
test('separate preparation sequences join exact requests and retain preparation-only uncertainty', () => {
  const snapshot = fixture(1);
  snapshot.preparationHistory = [{ revision: 900, kind: 'prepare', input: input('request-1'), plan },
    { revision: 901, kind: 'prepared', requestId: 'request-1' },
    { revision: 902, kind: 'prepare', input: input('preparation-only', 'account'), plan }];
  const rows = historyRows(snapshot);
  assert.equal(rows[0].id, 'preparation-only'); assert.equal(rows[0].source, 'preparation'); assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[1].revision, 1); assert.deepEqual(rows[1].events.map(e => [e.source, e.revision]), [['preparation', 900], ['preparation', 901], ['execution', 1]]);
});
test('duplicate IDs and cross-service or cross-plan joins fail closed', () => {
  const snapshot = fixture(1);
  snapshot.requests.push({ ...snapshot.requests[0], input: input('request-1', 'forum') });
  assert.throws(() => historyRows(snapshot)); snapshot.requests.pop();
  snapshot.preparationHistory = [{ revision: 1, kind: 'prepare', input: input('request-1', 'forum'), plan }];
  assert.throws(() => historyRows(snapshot));
  snapshot.preparationHistory[0].input = input('request-1'); snapshot.preparationHistory[0].plan = { ...plan, target: 'other' };
  assert.throws(() => historyRows(snapshot));
});
test('missing request or start never invents success; revoked approvals and events are retained', () => {
  const snapshot = fixture(1); snapshot.requests[0].status = 'succeeded'; snapshot.history = [];
  assert.equal(historyRows(snapshot)[0].status, 'unknown');
  snapshot.history = [{ revision: 1, kind: 'intent', input: input('request-1'), plan }]; snapshot.requests = [];
  assert.equal(historyRows(snapshot)[0].status, 'unknown');
  snapshot.requests = [{ input: input('request-1'), status: 'revoked' }];
  snapshot.history.push({ revision: 2, kind: 'restart', invalidated: ['request-1'] });
  assert.equal(historyRows(snapshot)[0].status, 'revoked'); assert.equal(historyRows(snapshot)[0].events.length, 2);
});
test('event view whitelists metadata and excludes actor/configuration/raw errors', () => {
  const result = eventRow({ revision: 1, kind: 'intent', input: input('id'), actor: { secret: 'PRIVATE' }, plan: { env: 'PRIVATE' }, error: 'PRIVATE' }, 'execution');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(result.requestId, 'id');
});

test('projected plan and input identity mismatches cannot inherit a successful status', () => {
  const snapshot = fixture(1); snapshot.requests[0].status = 'succeeded';
  snapshot.requests[0].plan = { ...plan, target: 'different-target' };
  assert.throws(() => historyRows(snapshot), /cross-plan/);
  snapshot.requests[0].plan = { artifact: plan.artifact, target: plan.target };
  assert.equal(historyRows(snapshot)[0].status, 'succeeded');
  snapshot.requests[0].input = { ...snapshot.requests[0].input, params: { substituted: true } };
  assert.throws(() => historyRows(snapshot), /cross-scope/);
});
test('large histories are indexed once, with restart associations retained', () => {
  const snapshot = fixture(1000); let reads = 0;
  snapshot.history = snapshot.history.map(event => new Proxy(event, { get(target, key) { reads++; return target[key]; } }));
  const rows = historyRows(snapshot);
  assert.equal(rows.length, 1000); assert.equal(pageRows(rows, 'all', 100).rows.length, 10);
  assert.ok(reads < 50000, `event accesses should be linear, got ${reads}`);
  const small = fixture(2); small.history.push({ revision: 3, kind: 'restart', invalidated: ['request-1', 'request-2'] });
  assert.deepEqual(historyRows(small).map(row => row.events.at(-1).kind), ['restart', 'restart']);
});
