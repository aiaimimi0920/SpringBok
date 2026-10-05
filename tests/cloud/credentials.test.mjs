import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, rmdirSync, readFileSync, writeFileSync, statSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { adminFixture, origin } from './admin-fixture.mjs';
import { joinChallengeDigest } from '../../cloud/enrollment-contract.mjs';
import { openEnrollmentClient } from '../../src/node-enrollment/client.mjs';
import { openCredentialClient } from '../../src/node-credentials/client.mjs';
import { readPrivateNodeJson } from '../../src/node-credentials/files.mjs';

const flags = { ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_NODE_CREDENTIALS: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' };
const options = { entryPoint: 'tests/cloud/enrollment-fixture.mjs' };
const identityPath = (credential, role = credential.role) => `/node/v2/identity/${role}/${credential.ownerId}/${credential.nodeId}`;
async function callIdentity(f, credential, extra = {}, expected = 200) {
  const r = await f.call(extra.path ?? identityPath(credential), { token: null, headers: { authorization: `Bearer ${credential.token}`, ...extra.headers }, body: extra.body ?? { protocolVersion: 2 }, ...(extra.method ? { method: extra.method } : {}) });
  assert.equal(r.status, expected, r.text); return r.json();
}
async function rpc(f, context, operation, args = [], expected = 200) {
  const r = await f.call('/__enrollment_fixture', { body: { resource: 'node', context: { ownerId: context.ownerId, nodeId: context.nodeId }, operation, args } }); assert.equal(r.status, expected, r.text); return expected === 200 ? r.json() : null;
}
async function prepareNode(f, directory, claims = {}) {
  const token = f.jwt(claims), session = (await f.call('/api/admin/state', { token })).json(), headers = { 'x-csrf-token': session.csrf };
  const revision = (await f.call('/api/admin/servers', { token })).json().revision;
  const response = await f.call('/api/admin/servers', { token, headers, body: { id: randomUUID(), revision, action: 'create', name: '角色测试节点' } }); assert.equal(response.status, 200);
  const nodeId = response.json().server.id, context = { ownerId: session.ownerId, nodeId };
  const grant = { protocolVersion: 2, origin, ...context, enrollmentId: randomUUID(), challenge: randomBytes(32).toString('hex') };
  const prepared = await f.call('/api/admin/enrollments', { token, headers, body: { id: grant.enrollmentId, revision: revision + 1, serverId: nodeId, challengeDigest: await joinChallengeDigest(context, grant.enrollmentId, grant.challenge) } }); assert.equal(prepared.status, 200);
  const state = join(directory, nodeId), output = join(directory, `${nodeId}-roles`), grantFile = join(directory, `${nodeId}-grant.json`);
  writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600, flag: 'wx' });
  const client = openEnrollmentClient({ directory: state, grant, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
  return { context, grant, grantFile, state, output, client };
}
function materials(node) { return ['execute', 'observe'].map(role => readPrivateNodeJson(join(node.output, `${role}.json`))); }

test('credential identity is default-off and strictly rejects unjoined, legacy and caller-provided authority', async () => {
  const disabled = await adminFixture();
  try { assert.equal((await disabled.call(`/node/v2/identity/execute/${'a'.repeat(64)}/${randomUUID()}`, { token: null, body: { protocolVersion: 2 } })).status, 503); } finally { await disabled.close(); }
  const f = await adminFixture(flags, options), directory = mkdtempSync(join(tmpdir(), 'springbok-credential-')); let node;
  try {
    node = await prepareNode(f, directory); const credential = { ...node.context, role: 'execute', token: randomBytes(32).toString('hex') };
    const before = await rpc(f, node.context, 'inspect'); await callIdentity(f, credential, {}, 409);
    const empty = { ...credential, nodeId: randomUUID() }; await callIdentity(f, empty, {}, 409); assert.deepEqual(await rpc(f, empty, 'inspect'), []);
    for (const body of [{ protocolVersion: 1 }, { protocolVersion: 2, role: 'execute' }, { protocolVersion: 2, ownerId: credential.ownerId }, { protocolVersion: 2, operation: 'deploy' }, { protocolVersion: 2, actor: 'human' }]) await callIdentity(f, credential, { body }, 409);
    await callIdentity(f, credential, { path: identityPath(credential) + '?token=1' }, 403);
    for (const headers of [{ cookie: 'test=1' }, { origin: 'https://other.invalid' }, { authorization: 'Bearer invalid' }, { 'content-type': 'text/plain' }]) await callIdentity(f, credential, { headers }, headers['content-type'] ? 409 : 403);
    await callIdentity(f, credential, { path: identityPath(credential, 'admin') }, 404);
    const http = await f.mf.dispatchFetch('http://admin.example.invalid' + identityPath(credential), { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2 }) }); assert.equal(http.status, 403);
    assert.deepEqual(await rpc(f, node.context, 'inspect'), before);
    await node.client.step(); node.client.exportCredentials(node.output); const [execute] = materials(node);
    for (const token of [node.grant.challenge, f.bindings.NODE_TOKEN, f.bindings.CONTROL_TOKEN]) await callIdentity(f, { ...execute, token }, {}, 409);
    for (const path of ['/node/v2/poll', '/node/v2/report', '/node/v2/approve', '/node/v2/metrics']) assert.notEqual((await f.call(path, { token: null, headers: { authorization: `Bearer ${execute.token}` }, body: { protocolVersion: 2 } })).status, 200);
    await callIdentity(f, execute, { method: 'PUT' }, 404);
    const result = await callIdentity(f, execute); assert.equal(result.executionReady, false); assert.deepEqual(result.capabilities, ['identity:self']);
    for (const secret of [execute.token, node.grant.challenge]) assert.equal(JSON.stringify(result).includes(secret), false);
  } finally { node?.client.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('two nodes, two owners and both role credentials authenticate only their own immutable persistent identity', async () => {
  const f = await adminFixture(flags, options), directory = mkdtempSync(join(tmpdir(), 'springbok-role-isolation-')), nodes = [];
  try {
    for (const claims of [{}, {}, { sub: 'different-role-owner' }]) { const node = await prepareNode(f, directory, claims); nodes.push(node); await node.client.step(); node.client.exportCredentials(node.output); }
    const all = nodes.map(materials), before = await Promise.all(nodes.map(node => rpc(f, node.context, 'inspect')));
    assert.equal(new Set(all.flat().map(value => value.token)).size, 6);
    for (const pair of all) for (const credential of pair) {
      const file = join(nodes[all.indexOf(pair)].output, `${credential.role}.json`), client = openCredentialClient({ file, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
      assert.equal((await client.inspect()).role, credential.role);
      await callIdentity(f, credential, { path: identityPath(credential, credential.role === 'execute' ? 'observe' : 'execute') }, 409);
      for (const target of all.flat().filter(other => other.role === credential.role && other.nodeId !== credential.nodeId)) await callIdentity(f, { ...target, token: credential.token }, {}, 409);
    }
    const wrongOwner = { ...all[0][0], ownerId: all[2][0].ownerId }; await callIdentity(f, wrongOwner, {}, 409); assert.deepEqual(await rpc(f, wrongOwner, 'inspect'), []);
    await rpc(f, nodes[0].context, 'credentialIdentity', [nodes[1].context, 'execute', all[0][0].token], 409);
    const parallel = await Promise.all(Array.from({ length: 8 }, () => callIdentity(f, all[0][0]))); assert.ok(parallel.every(row => row.nodeId === nodes[0].context.nodeId));
    assert.deepEqual(await Promise.all(nodes.map(node => rpc(f, node.context, 'inspect'))), before);
    const ledger = readFileSync(join(nodes[0].state, 'ledger.json')); await f.restart();
    const value = await openCredentialClient({ file: join(nodes[0].output, 'observe.json'), expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) }).inspect(); assert.equal(value.role, 'observe');
    assert.deepEqual(readFileSync(join(nodes[0].state, 'ledger.json')), ledger);
    const cloud = JSON.stringify(await Promise.all(nodes.map(node => rpc(f, node.context, 'inspect'))));
    for (const pair of all) for (const credential of pair) assert.equal(cloud.includes(credential.token), false);
    assert.equal((await f.call('/api/admin/state')).json().jobs.length, 0);
  } finally { for (const node of nodes) node.client.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('joined identity is authoritative across directory uncertainty, old join deadline and independent feature toggles', async () => {
  const f = await adminFixture({ ...flags, ENROLLMENT_FAULT: 'catalog-finalize-before' }, options), directory = mkdtempSync(join(tmpdir(), 'springbok-credential-toggle-')); let node;
  try {
    node = await prepareNode(f, directory); assert.equal((await node.client.step()).directoryState, 'uncertain'); node.client.exportCredentials(node.output); const [execute, observe] = materials(node);
    await callIdentity(f, execute); await rpc(f, node.context, 'damage', ['joined-age']); await callIdentity(f, execute);
    const before = await rpc(f, node.context, 'inspect');
    Object.assign(f.bindings, { ENABLE_NODE_ENROLLMENT: 'no', ENABLE_CATALOG: 'no', ENABLE_ADMIN: 'no' }); await f.restart();
    await callIdentity(f, execute); await callIdentity(f, observe); assert.deepEqual(await rpc(f, node.context, 'inspect'), before);
    f.bindings.ENABLE_NODE_CREDENTIALS = 'no'; await f.restart(); await callIdentity(f, execute, {}, 503); assert.deepEqual(await rpc(f, node.context, 'inspect'), before);
    f.bindings.ENABLE_NODE_CREDENTIALS = 'yes'; await f.restart(); await callIdentity(f, execute);
    f.bindings.ENABLE_NODE_MAILBOX = 'no'; await f.restart(); await callIdentity(f, execute, {}, 503); assert.deepEqual(await rpc(f, node.context, 'inspect'), before);
  } finally { node?.client.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exports require a joined receipt, recover partial publication without replacement and read only one private role file', async () => {
  const f = await adminFixture(flags, options), directory = mkdtempSync(join(tmpdir(), 'springbok-credential-export-')); let node;
  try {
    node = await prepareNode(f, directory); assert.throws(() => node.client.exportCredentials(node.output)); assert.equal(existsSync(node.output), false);
    await node.client.step(); const ledger = readFileSync(join(node.state, 'ledger.json'));
    mkdirSync(node.output, { mode: 0o700 }); mkdirSync(join(node.output, 'observe.json'));
    assert.throws(() => node.client.exportCredentials(node.output)); const first = readFileSync(join(node.output, 'execute.json')), modified = statSync(join(node.output, 'execute.json')).mtimeMs;
    rmdirSync(join(node.output, 'observe.json')); node.client.exportCredentials(node.output); node.client.exportCredentials(node.output);
    assert.deepEqual(readFileSync(join(node.output, 'execute.json')), first); assert.equal(statSync(join(node.output, 'execute.json')).mtimeMs, modified);
    const [execute, observe] = materials(node); for (const role of ['execute', 'observe']) assert.equal(statSync(join(node.output, `${role}.json`)).mode & 0o077, 0);
    assert.equal(statSync(node.output).mode & 0o077, 0); assert.deepEqual(readFileSync(join(node.state, 'ledger.json')), ledger);
    const conflict = { ...observe, token: randomBytes(32).toString('hex') }; writeFileSync(join(node.output, 'observe.json'), JSON.stringify(conflict));
    assert.throws(() => node.client.exportCredentials(node.output)); assert.deepEqual(readPrivateNodeJson(join(node.output, 'observe.json')), conflict); writeFileSync(join(node.output, 'observe.json'), JSON.stringify(observe));
    symlinkSync(join(node.output, 'observe.json'), join(directory, 'role-link')); assert.throws(() => openCredentialClient({ file: join(directory, 'role-link'), expectedOrigin: origin }));
    let requests = 0; const file = join(node.output, 'observe.json');
    assert.throws(() => openCredentialClient({ file, expectedOrigin: 'https://attacker.example.invalid', fetcher: () => { requests++; } })); assert.equal(requests, 0);
    chmodSync(file, 0o644); assert.throws(() => openCredentialClient({ file, expectedOrigin: origin })); chmodSync(file, 0o600);
    // 另一角色文件损坏，不影响只持有 observe 文件的读取和认证。
    writeFileSync(join(node.output, 'execute.json'), '{}'); assert.equal((await openCredentialClient({ file, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) }).inspect()).role, 'observe');
    writeFileSync(join(node.output, 'execute.json'), JSON.stringify(execute));
    await assert.rejects(openCredentialClient({ file, expectedOrigin: origin, fetcher: () => Response.json({ token: observe.token }) }).inspect());
    await assert.rejects(openCredentialClient({ file, expectedOrigin: origin, fetcher: (_url, init) => { assert.equal(init.redirect, 'error'); return new Response(null, { status: 307 }); } }).inspect());
    node.client.close(); node.client = { close() {} };
    const script = fileURLToPath(new URL('../../scripts/node-credential-export.mjs', import.meta.url));
    const exported = spawnSync(process.execPath, [script, '--grant', node.grantFile, '--state', node.state, '--expected-origin', origin, '--output', node.output], { encoding: 'utf8', timeout: 5000 }); assert.equal(exported.status, 0, exported.stderr); assert.equal(JSON.parse(exported.stdout).files.length, 2);
    for (const secret of [execute.token, observe.token, node.grant.challenge]) assert.equal((exported.stdout + exported.stderr).includes(secret), false);
    const identityScript = fileURLToPath(new URL('../../scripts/node-identity.mjs', import.meta.url));
    const rejected = spawnSync(process.execPath, [identityScript, '--credential', file, '--expected-origin', 'http://untrusted.invalid'], { encoding: 'utf8', timeout: 5000 }); assert.equal(rejected.status, 1); assert.equal(rejected.stderr.includes(observe.token), false);
    assert.deepEqual(readFileSync(join(node.state, 'ledger.json')), ledger);
  } finally { node?.client.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing, unknown and corrupt enrollment storage rejects role authentication without clearing evidence', async () => {
  const f = await adminFixture(flags, options), directory = mkdtempSync(join(tmpdir(), 'springbok-credential-storage-')), nodes = [];
  try {
    for (const kind of ['table', 'version', 'record']) {
      const node = await prepareNode(f, directory); nodes.push(node); await node.client.step(); node.client.exportCredentials(node.output); const [credential] = materials(node);
      await rpc(f, node.context, 'damage', [kind]); const damaged = await rpc(f, node.context, 'inspect'); await f.restart();
      await callIdentity(f, credential, {}, 409); assert.deepEqual(await rpc(f, node.context, 'inspect'), damaged);
    }
  } finally { for (const node of nodes) node.client.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy schema 1 identity is denied without migration or ledger writes', async () => {
  const f = await adminFixture(flags, options), context = { ownerId: 'a'.repeat(64), nodeId: randomUUID() };
  try {
    await rpc(f, context, 'legacySnapshot', [context]); const before = await rpc(f, context, 'inspect');
    assert.equal(before.find(row => row.name === 'node_meta').rows[0].schema_version, 1);
    await callIdentity(f, { ...context, role: 'execute', token: randomBytes(32).toString('hex') }, {}, 409);
    await f.restart(); assert.deepEqual(await rpc(f, context, 'inspect'), before);
  } finally { await f.close(); }
});

test('joined cloud state with a lost acknowledgment cannot export until the original journal replays its receipt', async () => {
  const f = await adminFixture(flags, options), directory = mkdtempSync(join(tmpdir(), 'springbok-credential-lost-ack-')); let node;
  try {
    node = await prepareNode(f, directory); node.client.close();
    node.client = openEnrollmentClient({ directory: node.state, grant: node.grant, expectedOrigin: origin, fetcher: async (url, init) => {
      const response = await f.mf.dispatchFetch(url, init); assert.equal(response.status, 200); await response.body.cancel(); throw new Error('simulated lost join acknowledgment');
    } });
    await assert.rejects(node.client.step()); const prepared = node.client.snapshot(), ledger = readFileSync(join(node.state, 'ledger.json'));
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.directoryState, 'unconfirmed');
    const cloud = await rpc(f, node.context, 'inspect'); assert.equal(JSON.parse(cloud.find(row => row.name === 'node_enrollment').rows[0].state).status, 'joined');
    assert.throws(() => node.client.exportCredentials(node.output)); assert.equal(existsSync(node.output), false); assert.deepEqual(readFileSync(join(node.state, 'ledger.json')), ledger);
    node.client.close(); await f.restart();
    node.client = openEnrollmentClient({ directory: node.state, grant: node.grant, expectedOrigin: origin, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
    assert.equal((await node.client.step()).status, 'joined'); assert.equal(node.client.snapshot().requestId, prepared.requestId);
    node.client.exportCredentials(node.output); const [execute, observe] = materials(node);
    assert.equal(node.client.snapshot().executeDigest, prepared.executeDigest); assert.equal(node.client.snapshot().observeDigest, prepared.observeDigest);
    await callIdentity(f, execute); await callIdentity(f, observe); assert.deepEqual(await rpc(f, node.context, 'inspect'), cloud);
  } finally { node?.client.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
