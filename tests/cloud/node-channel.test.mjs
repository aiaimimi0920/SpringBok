import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adminFixture, origin } from './admin-fixture.mjs';
import { joinChallengeDigest } from '../../cloud/enrollment-contract.mjs';
import { openEnrollmentClient } from '../../src/node-enrollment/client.mjs';
import { readPrivateNodeJson } from '../../src/node-credentials/files.mjs';
import { openNodeChannelClient } from '../../src/node-channel/client.mjs';
import { openNodeChannelBridge } from '../../src/node-channel/bridge.mjs';

const flags = { ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_NODE_CREDENTIALS: 'yes', ENABLE_NODE_CHANNEL: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' };
const fixtureOptions = { entryPoint: 'tests/cloud/enrollment-fixture.mjs' };
const contextOf = value => ({ ownerId: value.ownerId, nodeId: value.nodeId });
const pathOf = (credential, operation = 'poll', role = credential.role) => `/node/v2/channel/${role}/${credential.ownerId}/${credential.nodeId}/${credential.enrollmentId}/${operation}`;
const receiptOf = input => ({ protocolVersion: 2, requestId: input.requestId, planDigest: input.planDigest, challenge: input.challenge, outcome: 'observed' });
async function rpc(f, context, operation, args = []) {
  const r = await f.call('/__enrollment_fixture', { body: { resource: 'node', context: contextOf(context), operation, args } }); assert.equal(r.status, 200, r.text); return r.json();
}
async function roleCall(f, credential, operation = 'poll', body = { protocolVersion: 2 }, expected = 200, extra = {}) {
  const r = await f.call(extra.path ?? pathOf(credential, operation), { token: null, body, headers: { authorization: `Bearer ${credential.token}`, ...extra.headers }, ...(extra.method ? { method: extra.method } : {}) }); assert.equal(r.status, expected, r.text); return r.json();
}
async function makeNode(f, directory, claims = {}, joined = true) {
  const token = f.jwt(claims), session = (await f.call('/api/admin/state', { token })).json(), headers = { 'x-csrf-token': session.csrf };
  const revision = (await f.call('/api/admin/servers', { token })).json().revision;
  const created = await f.call('/api/admin/servers', { token, headers, body: { id: randomUUID(), revision, action: 'create', name: '已认证通道测试' } }); assert.equal(created.status, 200);
  const context = { ownerId: session.ownerId, nodeId: created.json().server.id }, grant = { protocolVersion: 2, origin, ...context, enrollmentId: randomUUID(), challenge: randomBytes(32).toString('hex') };
  const authorized = await f.call('/api/admin/enrollments', { token, headers, body: { id: grant.enrollmentId, revision: revision + 1, serverId: context.nodeId, challengeDigest: await joinChallengeDigest(context, grant.enrollmentId, grant.challenge) } }); assert.equal(authorized.status, 200);
  const roles = join(directory, `${context.nodeId}-roles`), state = join(directory, `${context.nodeId}-join`), channel = join(directory, `${context.nodeId}-channel`);
  const client = openEnrollmentClient({ directory: state, grant, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
  try { if (joined) { await client.step(); client.exportCredentials(roles); } } finally { client.close(); }
  const file = join(roles, 'execute.json'), observeFile = join(roles, 'observe.json');
  return { context, grant, file, observeFile, channel, token, headers, ...(joined ? { credential: readPrivateNodeJson(file) } : {}) };
}
async function admin(f, node, body, expected = 200, extra = {}) {
  const r = await f.call(`/api/admin/nodes/${node.context.nodeId}/probe`, { token: node.token, headers: node.headers, ...(body ? { body } : {}), ...extra }); assert.equal(r.status, expected, r.text); const data = r.json();
  if (expected === 200) { assert.equal(data.ownerId, node.context.ownerId); assert.equal(data.nodeId, node.context.nodeId); assert.equal(data.enrollmentId, node.grant.enrollmentId); assert.equal(data.executionReady, false); }
  return data;
}
async function submit(f, node, fields = {}) {
  const state = await admin(f, node), request = { requestId: randomUUID(), revision: state.revision, challenge: randomBytes(32).toString('hex'), ...fields }; await admin(f, node, request); return request;
}
function bridge(f, node, fetcher = (url, init) => f.mf.dispatchFetch(url, init)) { return openNodeChannelBridge({ directory: node.channel, file: node.file, expectedOrigin: origin, fetcher }); }
function ledger(f, node) { return admin(f, node); }

test('channel and administrator probe default off, require joined authority and preserve strict request/role boundaries', async () => {
  const off = await adminFixture();
  try { const fake = { ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID(), role: 'execute', token: randomBytes(32).toString('hex') }; await roleCall(off, fake, 'poll', { protocolVersion: 2 }, 503); assert.equal((await off.call(`/api/admin/nodes/${fake.nodeId}/probe`)).status, 503); } finally { await off.close(); }
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-boundary-'));
  try {
    const pending = await makeNode(f, directory, {}, false), fake = { ...pending.context, enrollmentId: pending.grant.enrollmentId, role: 'execute', token: randomBytes(32).toString('hex') }, before = await rpc(f, pending.context, 'inspect');
    await roleCall(f, fake, 'poll', { protocolVersion: 2 }, 409); await admin(f, pending, undefined, 409); assert.deepEqual(await rpc(f, pending.context, 'inspect'), before);
    const node = await makeNode(f, directory), credential = node.credential;
    await admin(f, node, { requestId: randomUUID(), revision: 0, challenge: 'a'.repeat(64) }, 403, { headers: {} });
    await admin(f, node, undefined, 403, { token: null });
    await admin(f, node, { requestId: randomUUID(), revision: 0, challenge: 'a'.repeat(64), ownerId: node.context.ownerId }, 409);
    for (const token of [f.bindings.NODE_TOKEN, f.bindings.CONTROL_TOKEN, node.grant.challenge, readPrivateNodeJson(node.observeFile).token]) await roleCall(f, { ...credential, token }, 'poll', { protocolVersion: 2 }, 409);
    await roleCall(f, readPrivateNodeJson(node.observeFile), 'poll', { protocolVersion: 2 }, 409);
    for (const body of [{ protocolVersion: 1 }, { protocolVersion: 2, role: 'execute' }, { protocolVersion: 2, operation: 'deploy' }, { protocolVersion: 2, actor: 'human' }]) await roleCall(f, credential, 'poll', body, 409);
    for (const headers of [{ cookie: 'test=1' }, { origin: 'https://other.invalid' }, { authorization: 'Bearer invalid' }]) await roleCall(f, credential, 'poll', { protocolVersion: 2 }, 403, { headers });
    await roleCall(f, credential, 'poll', { protocolVersion: 2 }, 403, { path: pathOf(credential) + '?query=1' });
    await roleCall(f, credential, 'deploy', { protocolVersion: 2 }, 404);
    await roleCall(f, credential, 'poll', { protocolVersion: 2 }, 404, { method: 'PUT' });
    const response = await f.mf.dispatchFetch('http://admin.example.invalid' + pathOf(credential), { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: '{"protocolVersion":2}' }); assert.equal(response.status, 403);
    assert.equal((await ledger(f, node)).jobs.length, 0);
    let calls = 0; const wrongState = join(directory, 'never-created');
    assert.throws(() => openNodeChannelBridge({ directory: wrongState, file: node.observeFile, expectedOrigin: origin, fetcher: () => { calls++; } }));
    assert.throws(() => openNodeChannelBridge({ directory: wrongState, file: node.file, expectedOrigin: 'https://attacker.invalid', fetcher: () => { calls++; } })); assert.equal(calls, 0); assert.equal(existsSync(wrongState), false);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real joined nodes and role files run the administrator to outbound bridge to SQLite receipt path without cross-owner/node/enrollment delivery', async () => {
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-e2e-')), nodes = [];
  try {
    for (const claims of [{}, {}, { sub: 'second-channel-owner' }]) nodes.push(await makeNode(f, directory, claims));
    const requestId = randomUUID(), challenge = randomBytes(32).toString('hex');
    for (const node of nodes) await submit(f, node, { requestId, challenge });
    const original = await Promise.all(nodes.map(node => ledger(f, node))); assert.equal(new Set(original.map(row => row.jobs[0].input.planDigest)).size, 3);
    for (const other of nodes.slice(1)) await roleCall(f, { ...other.credential, token: nodes[0].credential.token }, 'poll', { protocolVersion: 2 }, 409);
    await roleCall(f, { ...nodes[0].credential, ownerId: nodes[2].context.ownerId }, 'poll', { protocolVersion: 2 }, 409);
    await roleCall(f, { ...nodes[0].credential, enrollmentId: randomUUID() }, 'poll', { protocolVersion: 2 }, 409);
    await admin(f, nodes[0], undefined, 409, { token: nodes[2].token });
    assert.deepEqual(await Promise.all(nodes.map(node => ledger(f, node))), original);
    const a = await roleCall(f, nodes[0].credential), input = a.result.input;
    await roleCall(f, nodes[1].credential, 'report', receiptOf(input), 409);
    for (const extra of [{ planDigest: `sha256:${'f'.repeat(64)}` }, { challenge: 'f'.repeat(64) }, { nodeId: nodes[1].context.nodeId }, { outcome: 'deployed' }]) await roleCall(f, nodes[0].credential, 'report', { ...receiptOf(input), ...extra }, 409);
    await roleCall(f, nodes[0].credential, 'report', receiptOf(input));
    for (const node of nodes.slice(1)) { const b = bridge(f, node); try { assert.equal(await b.step(), 'observed'); assert.deepEqual(b.snapshot().map(event => event.kind), ['started', 'result', 'ack']); } finally { b.close(); } }
    for (const node of nodes) { const row = await ledger(f, node); assert.equal(row.executionReady, false); assert.equal(row.jobs[0].status, 'observed'); assert.equal(row.revision, 3); await admin(f, node, { requestId, revision: 0, challenge }); assert.equal((await ledger(f, node)).revision, 3); }
    const repeated = nodes[1], recorded = JSON.parse(readFileSync(join(repeated.channel, 'ledger.json'))).events;
    const duplicate = bridge(f, repeated, () => Response.json({ protocolVersion: 2, ...repeated.context, enrollmentId: repeated.grant.enrollmentId, role: 'execute', executionReady: false, result: { status: 'delivery', input: recorded[0].input } }));
    try { await assert.rejects(duplicate.step()); assert.deepEqual(duplicate.snapshot(), recorded); } finally { duplicate.close(); }
    await f.restart(); for (const node of nodes) assert.equal((await ledger(f, node)).jobs[0].status, 'observed');
    const before = readFileSync(join(nodes[1].channel, 'ledger.json')); assert.throws(() => openNodeChannelBridge({ directory: nodes[1].channel, file: nodes[2].file, expectedOrigin: origin })); assert.deepEqual(readFileSync(join(nodes[1].channel, 'ledger.json')), before);
    const raw = JSON.stringify(await Promise.all(nodes.map(node => rpc(f, node.context, 'inspect')))); for (const node of nodes) assert.equal(raw.includes(node.credential.token), false);
    assert.equal((await f.call('/api/admin/state')).json().jobs.length, 0);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('eight authenticated concurrent polls persist exactly one delivery and bind the final RPC context', async () => {
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-concurrent-'));
  try {
    const node = await makeNode(f, directory), other = await makeNode(f, directory); await submit(f, node);
    const rows = await Promise.all(Array.from({ length: 8 }, () => roleCall(f, node.credential))); assert.equal(rows.filter(row => row.result.status === 'delivery').length, 1); assert.equal(rows.filter(row => row.result.status === 'claimed').length, 7);
    assert.equal((await ledger(f, node)).revision, 2);
    const mismatch = await f.call('/__enrollment_fixture', { body: { resource: 'node', context: node.context, operation: 'credentialProbe', args: [other.context, 'execute', node.credential.token, node.credential.enrollmentId, 'poll', { protocolVersion: 2 }] } }); assert.equal(mismatch.status, 409);
    const input = rows.find(row => row.result.status === 'delivery').result.input; await roleCall(f, node.credential, 'report', receiptOf(input)); await roleCall(f, node.credential, 'report', receiptOf(input)); assert.equal((await ledger(f, node)).revision, 3);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lost report acknowledgment and local ack write failure replay only the original receipt, never a fresh poll or plan', async () => {
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-ack-')); let b;
  try {
    for (const failure of ['lost-response', 'local-write']) {
      const node = await makeNode(f, directory); await submit(f, node); let polls = 0, reports = 0, body; const file = join(node.channel, 'ledger.json'), backup = join(node.channel, 'saved-ledger.json');
      b = bridge(f, node, async (url, init) => {
        if (url.endsWith('/poll')) polls++; else { reports++; body = init.body; }
        const response = await f.mf.dispatchFetch(url, init);
        if (url.endsWith('/report')) { assert.equal(response.status, 200); if (failure === 'lost-response') { await response.body.cancel(); throw new Error('lost ack'); } renameSync(file, backup); mkdirSync(file); }
        return response;
      });
      await assert.rejects(b.step()); if (failure === 'local-write') await assert.rejects(b.step()); assert.equal(polls, 1); assert.equal(reports, 1); b.close(); b = null;
      if (failure === 'local-write') { rmdirSync(file); renameSync(backup, file); }
      await f.restart(); b = bridge(f, node, (url, init) => { assert.ok(url.endsWith('/report')); assert.equal(init.body, body); return f.mf.dispatchFetch(url, init); });
      assert.equal(await b.step(), 'observed'); assert.equal(b.snapshot().filter(event => event.kind === 'started').length, 1); assert.equal((await ledger(f, node)).jobs[0].status, 'observed'); b.close(); b = null;
    }
  } finally { b?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('intent-only and observed-to-unknown acknowledgment retain permanent local blocking after normal journal reopen', async () => {
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-unknown-')); let b;
  try {
    const node = await makeNode(f, directory); await submit(f, node); const delivery = await roleCall(f, node.credential);
    b = bridge(f, node); b.close(); b = null; const file = join(node.channel, 'ledger.json'), data = JSON.parse(readFileSync(file)); data.events = [{ revision: 1, kind: 'started', input: delivery.result.input }]; writeFileSync(file, JSON.stringify(data));
    let calls = 0; b = bridge(f, node, (url, init) => { calls++; assert.ok(url.endsWith('/report')); assert.equal(JSON.parse(init.body).outcome, 'unknown'); return f.mf.dispatchFetch(url, init); });
    assert.equal(b.snapshot()[1].receipt.outcome, 'unknown'); assert.equal(await b.step(), 'unknown'); assert.equal(await b.step(), 'unknown'); assert.equal(calls, 1); b.close(); b = null;
    b = bridge(f, node, () => { throw new Error('must not request after unknown'); }); assert.equal(await b.step(), 'unknown'); b.close(); b = null;
    await admin(f, node, { requestId: randomUUID(), revision: 3, challenge: randomBytes(32).toString('hex') }, 409);
    const late = await makeNode(f, directory); await submit(f, late); let polls = 0;
    b = bridge(f, late, async (url, init) => { if (url.endsWith('/poll')) polls++; else await rpc(f, late.context, 'damage', ['probe-expire']); return f.mf.dispatchFetch(url, init); });
    assert.equal(await b.step(), 'unknown'); assert.equal(b.snapshot()[1].receipt.outcome, 'observed'); assert.equal(b.snapshot()[2].status, 'unknown'); assert.equal(await b.step(), 'unknown'); assert.equal(polls, 1);
  } finally { b?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lost delivery cannot invent a local receipt; remote unknown is journaled and stops future polls across reopen', async () => {
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-lost-delivery-')); let b;
  try {
    const node = await makeNode(f, directory); await submit(f, node); b = bridge(f, node, async (url, init) => { const response = await f.mf.dispatchFetch(url, init); await response.body.cancel(); throw new Error('lost delivery'); });
    await assert.rejects(b.step()); assert.deepEqual(b.snapshot(), []); b.close(); b = null;
    let calls = 0; b = bridge(f, node, (url, init) => { calls++; assert.ok(url.endsWith('/poll')); return f.mf.dispatchFetch(url, init); });
    assert.equal(await b.step(), 'claimed'); assert.deepEqual(b.snapshot(), []); await rpc(f, node.context, 'damage', ['probe-expire']); assert.equal(await b.step(), 'unknown'); assert.equal(b.snapshot()[0].kind, 'remote-unknown'); assert.equal(await b.step(), 'unknown'); assert.equal(calls, 2); b.close(); b = null;
    b = bridge(f, node, () => { throw new Error('must preserve unknown without poll'); }); assert.equal(await b.step(), 'unknown');
    const state = await ledger(f, node); assert.equal(state.jobs[0].status, 'unknown'); assert.equal(Object.hasOwn(state.jobs[0], 'receipt'), false);
  } finally { b?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('joined channel ignores join/directory/admin toggles but enforces independent credentials/channel gates and corrupt or legacy storage', async () => {
  const f = await adminFixture({ ...flags, ENROLLMENT_FAULT: 'catalog-finalize-before' }, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-storage-'));
  try {
    const node = await makeNode(f, directory); await submit(f, node); assert.equal((await ledger(f, node)).jobs.length, 1);
    Object.assign(f.bindings, { ENABLE_NODE_ENROLLMENT: 'no', ENABLE_CATALOG: 'no', ENABLE_ADMIN: 'no' }); await f.restart(); const claimed = await roleCall(f, node.credential); await roleCall(f, node.credential, 'report', receiptOf(claimed.result.input));
    const before = await rpc(f, node.context, 'inspect');
    for (const feature of ['ENABLE_NODE_CHANNEL', 'ENABLE_NODE_CREDENTIALS', 'ENABLE_NODE_MAILBOX']) { f.bindings[feature] = 'no'; await f.restart(); await roleCall(f, node.credential, 'poll', { protocolVersion: 2 }, 503); assert.deepEqual(await rpc(f, node.context, 'inspect'), before); f.bindings[feature] = 'yes'; }
    Object.assign(f.bindings, { ...flags, ENABLE_ADMIN: 'yes' }); await f.restart();
    for (const kind of ['table', 'version', 'record']) { const damaged = await makeNode(f, directory); await submit(f, damaged); await rpc(f, damaged.context, 'damage', [kind]); const evidence = await rpc(f, damaged.context, 'inspect'); await f.restart(); await roleCall(f, damaged.credential, 'poll', { protocolVersion: 2 }, 409); assert.deepEqual(await rpc(f, damaged.context, 'inspect'), evidence); }
    const legacy = { ownerId: 'a'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID(), role: 'execute', token: randomBytes(32).toString('hex') }; await rpc(f, legacy, 'legacySnapshot', [contextOf(legacy)]); const old = await rpc(f, legacy, 'inspect'); await roleCall(f, legacy, 'poll', { protocolVersion: 2 }, 409); assert.deepEqual(await rpc(f, legacy, 'inspect'), old);
    const empty = { ...legacy, nodeId: randomUUID() }; await roleCall(f, empty, 'poll', { protocolVersion: 2 }, 409); assert.deepEqual(await rpc(f, empty, 'inspect'), []);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('client rejects corrupt plan hashes and wrong response authority before intent, and CLI rejects unsafe origin without secrets', async () => {
  const f = await adminFixture(flags, fixtureOptions), directory = mkdtempSync(join(tmpdir(), 'springbok-channel-client-')); let b;
  try {
    const node = await makeNode(f, directory); await submit(f, node); const row = await ledger(f, node), plan = row.jobs[0].input;
    const envelope = { protocolVersion: 2, ...node.context, enrollmentId: node.grant.enrollmentId, role: 'execute', executionReady: false, result: { status: 'delivery', input: { ...plan, planDigest: `sha256:${'f'.repeat(64)}` } } };
    b = bridge(f, node, () => Response.json(envelope)); await assert.rejects(b.step()); assert.deepEqual(b.snapshot(), []); b.close(); b = null;
    for (const extra of [{ ownerId: 'f'.repeat(64) }, { nodeId: randomUUID() }, { enrollmentId: randomUUID() }, { role: 'observe' }, { executionReady: true }]) await assert.rejects(openNodeChannelClient({ file: node.file, expectedOrigin: origin, fetcher: () => Response.json({ ...envelope, ...extra }) }).call('poll', { protocolVersion: 2 }));
    await assert.rejects(openNodeChannelClient({ file: node.file, expectedOrigin: origin, fetcher: (_url, init) => { assert.equal(init.redirect, 'error'); return new Response(null, { status: 307 }); } }).call('poll', { protocolVersion: 2 }));
    const script = fileURLToPath(new URL('../../scripts/node-channel.mjs', import.meta.url)), cli = spawnSync(process.execPath, [script, '--credential', node.file, '--expected-origin', 'http://untrusted.invalid', '--state', join(directory, 'cli-state')], { encoding: 'utf8', timeout: 5000 }); assert.equal(cli.status, 1); assert.equal(existsSync(join(directory, 'cli-state')), false); assert.equal((cli.stdout + cli.stderr).includes(node.credential.token), false);
    assert.equal((await ledger(f, node)).jobs[0].status, 'queued');
    const eventsFile = join(node.channel, 'ledger.json'), data = JSON.parse(readFileSync(eventsFile)); data.events = [{ revision: 1, kind: 'started', input: envelope.result.input }]; writeFileSync(eventsFile, JSON.stringify(data)); assert.throws(() => bridge(f, node)); assert.deepEqual(JSON.parse(readFileSync(eventsFile)), data);
  } finally { b?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
