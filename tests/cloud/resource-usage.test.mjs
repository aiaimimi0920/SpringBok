import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { usageFixture, databaseOne } from './usage-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
const path = '/api/admin/resources';
async function setup() {
  const fixture = await usageFixture(), { f } = fixture, token = f.jwt(), state = (await f.call('/api/admin/state', { token })).json();
  const session = { token, headers: { 'x-csrf-token': state.csrf } };
  const connection = (await f.call('/api/admin/connections', { ...session, body: { action: 'connect', id: randomUUID(), name: '用量测试', provider: 'cloudflare', accountId: '', token: fakeToken } })).json().connections[0];
  const ns = await f.mf.getDurableObjectNamespace('CONNECTIONS'), stub = ns.get(ns.idFromName('connections/v1/' + state.ownerId));
  const usage = { action: 'usage', connectionId: connection.id, kind: 'd1' };
  const budget = { action: 'budget', connectionId: connection.id, connectionRevision: 1, kind: 'd1', revision: 0, value: 10e9 };
  return { ...fixture, session, connection, stub, usage, budget, owner: state.ownerId };
}
test('usage stays read-only, budgets persist separately without rewriting credentials or deployment registrations', async () => {
  const { f, state, session, stub, usage, budget, owner } = await setup();
  try {
    const before = await stub.inspectStorage();
    const first = await f.call(path, { ...session, body: usage }); assert.equal(first.status, 200, first.text);
    assert.equal(first.json().samples[databaseOne].storage.value, 4e9); assert.equal(first.json().metrics[0].allowance.value, 5e9);
    assert.deepEqual(first.json().budget, { revision: 0, value: null });
    assert.deepEqual(await stub.inspectBudgetTables(), [], 'Read-only usage does not initialize planning storage');
    assert.equal((await f.call(path, { ...session, body: budget })).status, 200);
    assert.equal((await f.call(path, { ...session, body: budget })).status, 409, 'CAS refuses ambiguous replay');
    await f.restart(); const saved = (await f.call(path, { ...session, body: usage })).json(); assert.deepEqual(saved.budget, { revision: 1, value: 10e9 });
    assert.equal(saved.metrics[0].allowance.value, 5e9, 'Planning never edits supplier allowance');
    const ns = await f.mf.getDurableObjectNamespace('CONNECTIONS');
    assert.deepEqual(await ns.get(ns.idFromName('connections/v1/' + owner)).inspectStorage(), before);
    assert.equal((await f.call(path, session)).json().resources.length, 0);
    assert.equal((await f.call('/api/admin/state', session)).json().jobs.length, 0);
    assert.ok(state.requests.every(row => row.method === 'GET' || row.method === 'POST' && row.url === 'https://api.cloudflare.com/client/v4/graphql'));
    const cleared = await f.call(path, { ...session, body: { ...budget, revision: 1, value: null } }); assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json().budget, { revision: 2, value: null });
    assert.ok(!first.text.includes(fakeToken));
  } finally { await f.close(); }
});
test('usage and planning enforce owner, CSRF, kind, revision and fixed supplier query boundaries', async () => {
  const { f, session, connection, usage, budget } = await setup();
  try {
    for (const body of [usage, budget]) {
      assert.equal((await f.call(path, { token: session.token, body })).status, 403);
      assert.equal((await f.call(path, { ...session, token: null, body })).status, 403);
      assert.equal((await f.call(path, { ...session, body: { ...body, query: 'arbitrary' } })).status, 409);
      const other = f.jwt({ sub: 'other-owner' }), state = (await f.call('/api/admin/state', { token: other })).json();
      assert.equal((await f.call(path, { token: other, headers: { 'x-csrf-token': state.csrf }, body })).status, 409);
    }
    for (const patch of [{ value: -1 }, { value: '1' }, { value: 1e16 }, { kind: 'worker' }, { connectionRevision: 2 }, { revision: -1 }])
      assert.equal((await f.call(path, { ...session, body: { ...budget, ...patch } })).status, 409);
    assert.equal((await f.call('/api/admin/connections', { ...session, body: { action: 'disable', id: connection.id, revision: 1 } })).status, 200);
    assert.equal((await f.call(path, { ...session, body: usage })).status, 409);
    assert.equal((await f.call(path, { ...session, body: budget })).status, 409);
  } finally { await f.close(); }
});
test('provider failure preserves unknowns and planning; damaged budget storage fails closed', async () => {
  const { f, state, session, usage, budget, stub } = await setup();
  try {
    await f.call(path, { ...session, body: budget }); state.usageDenied = true;
    const failed = await f.call(path, { ...session, body: usage }); assert.equal(failed.status, 200);
    assert.equal(failed.json().status, 'unavailable'); assert.deepEqual(failed.json().samples, {}); assert.equal(failed.json().budget.value, 10e9);
    assert.ok(!failed.text.includes('synthetic provider error'));
    await stub.breakStorage('budgets');
    assert.equal((await f.call(path, { ...session, body: usage })).status, 409);
    assert.equal((await f.call(path, { ...session, body: { ...budget, revision: 1 } })).status, 409);
  } finally { await f.close(); }
});
test('in-flight usage cannot cross a connection revision or disable', async () => {
  const { f, state, session, usage, connection } = await setup(); let release;
  try {
    let started; const observed = new Promise(resolve => { started = resolve; }); state.onRequest = started;
    state.hold = new Promise(resolve => { release = resolve; }); const pending = f.call(path, { ...session, body: usage }); await observed;
    await f.call('/api/admin/connections', { ...session, body: { action: 'disable', id: connection.id, revision: 1 } });
    state.hold = null; state.onRequest = null; release(); assert.equal((await pending).status, 409);
  } finally { release?.(); await f.close(); }
});
test('planning has one account-level CAS across credentials and refuses newer storage without altering it', async () => {
  const { f, session, connection, usage, budget, stub } = await setup();
  try {
    const other = (await f.call('/api/admin/connections', { ...session, body: { action: 'connect', id: randomUUID(), name: '第二个凭据', provider: 'cloudflare', accountId: '', token: fakeToken } })).json().connections.find(row => row.target === connection.target);
    assert.notEqual(other.id, connection.id);
    const outcomes = await Promise.all([budget, { ...budget, connectionId: other.id, value: 20e9 }].map(body => f.call(path, { ...session, body })));
    assert.deepEqual(outcomes.map(reply => reply.status).sort(), [200, 409]);
    const saved = outcomes.find(reply => reply.status === 200).json().budget;
    assert.deepEqual((await f.call(path, { ...session, body: { ...usage, connectionId: other.id } })).json().budget, saved);
    const before = await stub.inspectStorage(); await stub.breakStorage('budget-version');
    assert.equal((await f.call(path, { ...session, body: usage })).status, 409);
    assert.equal((await f.call(path, { ...session, body: { ...budget, revision: 1 } })).status, 409);
    assert.deepEqual(await stub.inspectStorage(), before);
    assert.equal((await stub.inspectBudgetTables()).length, 2);
  } finally { await f.close(); }
});
