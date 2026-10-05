import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = entry => build({ entryPoints: [join(root, entry)], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] }).then(result => result.outputFiles[0].text);
const request = revision => ({ requestId: randomUUID(), revision, challenge: randomBytes(32).toString('hex') });
const receipt = input => ({ protocolVersion: 2, requestId: input.requestId, planDigest: input.planDigest, challenge: input.challenge, outcome: 'observed' });
const temporaryRoot = resolve(tmpdir());
const inside = (root, path) => { const part = relative(root, resolve(path)); return part !== '' && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(part); };
function temporaryDirectory(prefix) {
  if (process.platform === 'win32' && !inside(resolve('C:/Users/Public/nas_home/AI/GameEditor/linshi'), join(temporaryRoot, prefix))) throw new Error('set TEMP/TMP inside linshi before running workerd tests');
  return mkdtempSync(join(temporaryRoot, prefix));
}
function cleanup(directory) {
  assert.ok(inside(temporaryRoot, directory), 'test cleanup must remain inside the checked temporary root');
  rmSync(directory, { recursive: true, force: true });
}

test('independent SQLite mailboxes bind trusted RPC scope, claim once and persist without an HTTP node channel', async () => {
  const directory = temporaryDirectory('springbok-nodes-');
  const options = { modules: true, script: await bundle('tests/cloud/node-mailbox-fixture.mjs'), compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0,
    durableObjects: { NODES: { className: 'TestNodeMailbox', useSQLite: true } }, resourcePersistencePath: join(directory, 'state'), telemetry: { enabled: false }, cf: false, bindings: { ENABLE_NODE_MAILBOX: 'yes' } };
  let mf;
  const restart = async () => { await mf?.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); await mf.ready; };
  const a = { ownerId: 'a'.repeat(64), nodeId: randomUUID() }, b = { ...a, nodeId: randomUUID() }, c = { ...a, ownerId: 'c'.repeat(64) };
  async function call(target, operation, value, context = target, status = 200) {
    const response = await mf.dispatchFetch('https://internal.invalid/', { method: 'POST', body: JSON.stringify({ target, context, operation, value }) });
    assert.equal(response.status, status, `${operation} expected ${status}`); return response.json();
  }
  try {
    await restart();
    // 首次绑定前就核对 DO 名称，不能用错误上下文占用别人的空邮箱。
    await call(a, 'snapshot', undefined, b, 409); assert.deepEqual(await call(a, 'inspect'), []);
    for (const context of [a, b, c]) assert.equal((await call(context, 'snapshot')).jobs.length, 0);
    const input = request(0);
    for (const context of [a, b, c]) assert.equal((await call(context, 'submitProbe', input)).status, 'queued');
    assert.deepEqual(await call(a, 'submitProbe', input), { requestId: input.requestId, status: 'queued' });
    await call(a, 'submitProbe', { ...input, challenge: 'f'.repeat(64) }, a, 409);
    for (const value of [{ ...input, ownerId: a.ownerId }, { ...input, nodeId: a.nodeId }, { ...input, operation: 'fixture-cycle' }, { ...input, environment: 'production' }]) await call(a, 'submitProbe', value, a, 409);
    await call(a, 'pollProbe', { protocolVersion: 2 }, b, 409);
    await call(a, 'pollProbe', { protocolVersion: 2, nodeId: b.nodeId }, a, 409);
    await call(a, 'pollProbe', { protocolVersion: 1 }, a, 409);
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(a, 'pollProbe', { protocolVersion: 2 })));
    assert.equal(responses.filter(value => value.status === 'delivery').length, 1);
    assert.equal(responses.filter(value => value.status === 'claimed').length, 7);
    const delivered = responses.find(value => value.status === 'delivery').input;
    assert.equal(delivered.ownerId, a.ownerId); assert.equal(delivered.nodeId, a.nodeId); assert.equal(delivered.serviceId, null);
    await call(b, 'reportProbe', receipt(delivered), b, 409);
    await call(c, 'reportProbe', receipt(delivered), c, 409);
    assert.equal((await call(b, 'snapshot')).jobs[0].status, 'queued');
    const bDelivery = await call(b, 'pollProbe', { protocolVersion: 2 }); assert.equal(bDelivery.status, 'delivery');
    assert.notEqual(bDelivery.input.planDigest, delivered.planDigest);
    await call(b, 'reportProbe', receipt(delivered), b, 409); // 相同 request/challenge 也不串节点。
    await call(a, 'reportProbe', { ...receipt(delivered), protocolVersion: 1 }, a, 409);
    await call(a, 'reportProbe', { ...receipt(delivered), outcome: 'fixture-verified', evidence: {} }, a, 409);
    const saved = await call(a, 'snapshot'); await restart();
    assert.deepEqual(await call(a, 'snapshot'), saved);
    assert.equal((await call(a, 'pollProbe', { protocolVersion: 2 })).status, 'claimed');
    const ack = await call(a, 'reportProbe', receipt(delivered)); assert.equal(ack.status, 'observed');
    const observed = await call(a, 'snapshot');
    assert.deepEqual(await call(a, 'reportProbe', receipt(delivered)), ack); assert.deepEqual(await call(a, 'snapshot'), observed);
    await restart(); assert.deepEqual(await call(a, 'reportProbe', receipt(delivered)), ack);
    assert.deepEqual(await call(a, 'snapshot'), observed); // 丢 ack 后重启重送，不重新交付。
    await call(b, 'reportProbe', { ...receipt(bDelivery.input), outcome: 'unknown' });
    await call(b, 'reportProbe', receipt(bDelivery.input), b, 409);
    await call(b, 'submitProbe', request((await call(b, 'snapshot')).revision), b, 409);
    await restart(); assert.equal((await call(b, 'pollProbe', { protocolVersion: 2 })).status, 'unknown');
    const next = request(observed.revision); assert.equal((await call(a, 'submitProbe', next)).status, 'queued');
    assert.equal((await call(c, 'snapshot')).jobs[0].status, 'queued');
    const beforeToggle = await call(a, 'inspect');
    options.bindings.ENABLE_NODE_MAILBOX = 'no'; await restart();
    await call(a, 'snapshot', undefined, a, 409); await call(a, 'submitProbe', next, a, 409);
    assert.deepEqual(await call(a, 'inspect'), beforeToggle);
    options.bindings.ENABLE_NODE_MAILBOX = 'yes'; await restart(); assert.equal((await call(a, 'snapshot')).jobs.length, 2);
    for (const claimed of [false, true]) {
      const target = { ...a, nodeId: randomUUID() }, input = request(0);
      await call(target, 'submitProbe', input);
      const delivery = claimed ? await call(target, 'pollProbe', { protocolVersion: 2 }) : null;
      await call(target, 'damage', 'expire'); await restart();
      assert.equal((await call(target, 'pollProbe', { protocolVersion: 2 })).status, claimed ? 'unknown' : 'expired');
      if (claimed) assert.equal((await call(target, 'reportProbe', receipt(delivery.input))).status, 'unknown');
      await restart(); assert.equal((await call(target, 'pollProbe', { protocolVersion: 2 })).status, claimed ? 'unknown' : 'idle');
    }
    const full = { ...a, nodeId: randomUUID() }; let revision = 0, first;
    for (let index = 0; index < 100; index++) {
      const input = request(revision); first ??= input;
      await call(full, 'submitProbe', input);
      const delivery = await call(full, 'pollProbe', { protocolVersion: 2 });
      await call(full, 'reportProbe', receipt(delivery.input)); revision += 3;
    }
    const fullState = await call(full, 'snapshot'); assert.equal(fullState.jobs.length, 100); assert.equal(fullState.revision, revision);
    await call(full, 'submitProbe', request(revision), full, 409);
    assert.equal((await call(full, 'submitProbe', first)).status, 'observed');
    await restart(); assert.deepEqual(await call(full, 'snapshot'), fullState);
    for (const kind of ['version', 'owner', 'table', 'column', 'row', 'digest', 'json']) {
      const target = { ...a, nodeId: randomUUID() };
      await call(target, 'submitProbe', request(0)); await call(target, 'damage', kind);
      const damaged = await call(target, 'inspect'); await restart();
      await call(target, 'snapshot', undefined, target, 409);
      await call(target, 'pollProbe', { protocolVersion: 2 }, target, 409);
      assert.deepEqual(await call(target, 'inspect'), damaged, `${kind} must not reset data`);
    }
  } finally { await mf?.dispose(); cleanup(directory); }
});

test('production Worker never maps HTTP self-reported v2 identities into internal RPC, even with legacy credentials', async () => {
  const dir = temporaryDirectory('springbok-node-boundary-');
  const node = randomBytes(32).toString('hex'), control = randomBytes(32).toString('hex');
  const options = { modules: true, script: await bundle('cloud/worker.mjs'), compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0,
    durableObjects: { NODES: { className: 'NodeMailbox', useSQLite: true }, TARGET: { className: 'TargetMailbox', useSQLite: true } }, resourcePersistencePath: join(dir, 'state'), telemetry: { enabled: false }, cf: false,
    bindings: { ENABLE_NODE_MAILBOX: 'yes', ENABLE_PROTOCOL_TEST: 'yes', NODE_TOKEN: node, CONTROL_TOKEN: control } };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    await mf.ready;
    for (const path of ['/node/v2/poll', '/node/v2/report', '/v2/node/poll', '/control/v2/submit', '/api/admin/nodes']) {
      const response = await mf.dispatchFetch('https://control.invalid' + path, { method: 'POST', headers: { authorization: `Bearer ${node}`, 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: 'a'.repeat(64), nodeId: randomUUID(), ...request(0) }) });
      assert.equal(response.status, 404);
    }
    const state = await mf.dispatchFetch('https://control.invalid/control/state', { headers: { authorization: `Bearer ${control}` } });
    assert.deepEqual((await state.json()).jobs, []);
    await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, ENABLE_ADMIN: 'yes' } }));
    assert.equal((await mf.dispatchFetch('https://control.invalid/node/v2/poll', { method: 'POST', headers: { authorization: `Bearer ${node}` } })).status, 404);
    assert.equal((await mf.dispatchFetch('https://control.invalid/v2/node/poll', { method: 'POST', headers: { authorization: `Bearer ${node}` } })).status, 403);
    const disabled = new Miniflare(convertV4MiniflareOptions({ ...options, resourcePersistencePath: join(dir, 'disabled'), bindings: {} }));
    try { await disabled.ready; assert.equal((await disabled.dispatchFetch('https://control.invalid/node/v2/poll')).status, 503); } finally { await disabled.dispose(); }
  } finally { await mf.dispose(); cleanup(dir); }
});
