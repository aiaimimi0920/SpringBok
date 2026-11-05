import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDeletionBucket, deletionBucketAbsent, removeDeletionBucket } from '../cloud/service-deletion-r2.mjs';

const row = { kind: 'r2', accountId: 'a'.repeat(32), remoteId: 'test-email-inbox', name: 'test-email-inbox' };
const entry = key => ({ key, size: 12, etag: 'a'.repeat(32), last_modified: '2026-11-06T00:00:00.000Z' });
function provider() {
  const state = { entries: [entry('message.eml')], truncated: false, cursor: '', buckets: [{ name: row.name, creation_date: '2026-11-06T00:00:00Z', jurisdiction: 'default' }],
    reads: [], writes: [], badResponse: null, deletedKeys: null };
  const transport = async (url, options) => {
    const path = new URL(url).pathname, ok = (result, result_info) => Response.json({ success: true, errors: [], result, ...(result_info ? { result_info } : {}) });
    if (options.method === 'DELETE') {
      state.writes.push({ path, body: options.body });
      if (state.badResponse) return state.badResponse();
      if (path.endsWith('/objects')) {
        const keys = JSON.parse(options.body); state.entries = [];
        return ok((state.deletedKeys ?? keys).map(key => ({ key })));
      }
      state.buckets = []; return ok({});
    }
    state.reads.push(path);
    if (path.endsWith('/r2/buckets')) return ok({ buckets: state.buckets }, { cursor: state.cursor });
    if (path.endsWith('/objects')) return ok(state.entries, { is_truncated: state.truncated });
    if (path.endsWith('/lock')) return ok({ rules: [] });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    if (path.endsWith('/domains/managed')) return ok({ enabled: false });
    if (path.endsWith('/configuration')) return ok({ queues: [] });
    throw new Error('unexpected test request');
  };
  return { state, transport, inspect: () => inspectDeletionBucket(row, 'synthetic', transport) };
}

test('R2 absent bucket is verified from exact bounded inventory without reading contents', async () => {
  const p = provider(); p.state.buckets = [];
  assert.deepEqual(await p.inspect(), { ...row, present: false });
  assert.equal(await deletionBucketAbsent(row, 'synthetic', p.transport), true);
  assert.equal(p.state.reads.length, 2); assert.equal(p.state.writes.length, 0);
});

test('R2 object snapshots are order-independent and expose only counts and digest', async () => {
  const p = provider(); p.state.entries = [entry('z.eml'), entry('a.eml')];
  const first = await p.inspect(); p.state.entries.reverse();
  assert.deepEqual(await p.inspect(), first); assert.equal(first.objects.count, 2);
  assert.equal(first.objects.bytes, 24); assert.ok(!JSON.stringify(first).includes('z.eml'));
  p.state.entries[0].last_modified = '2026-11-06T01:00:00Z';
  assert.notEqual((await p.inspect()).objects.digest, first.objects.digest);
});

test('R2 boundary accepts exactly 1000 objects and rejects unbounded, duplicate or malformed metadata before writes', async () => {
  const p = provider(); p.state.entries = Array.from({ length: 1000 }, (_, index) => entry(String(index)));
  assert.equal((await p.inspect()).objects.count, 1000);
  for (const entries of [[...p.state.entries, entry('overflow')], [entry('same'), entry('same')], [entry('')],
    [entry('x'.repeat(1025))], [{ ...entry('a'), size: -1 }], [{ ...entry('a'), etag: '' }],
    [{ ...entry('a'), last_modified: 'invalid' }], [{ ...entry('a'), size: Number.MAX_SAFE_INTEGER }, entry('b')]]) {
    p.state.entries = entries; await assert.rejects(p.inspect());
  }
  assert.equal(p.state.writes.length, 0);
});

test('R2 bucket pagination, jurisdiction, identity and creation metadata fail closed', async () => {
  const p = provider(); p.state.cursor = 'another-page'; await assert.rejects(p.inspect());
  p.state.cursor = ''; p.state.buckets[0].jurisdiction = 'eu'; await assert.rejects(p.inspect());
  p.state.buckets[0].jurisdiction = 'default'; p.state.buckets[0].creation_date = ''; await assert.rejects(p.inspect());
  p.state.buckets[0].creation_date = '2026-11-06T00:00:00Z'; p.state.buckets.push(p.state.buckets[0]); await assert.rejects(p.inspect());
  assert.equal(p.state.writes.length, 0);
});

test('R2 deletion checks precise key readback, rejects HTTP 200 failures and never deletes bucket after object uncertainty', async () => {
  for (const failure of ['missing', 'partial', 'invalid', 'denied']) {
    const p = provider(), snapshot = await p.inspect();
    if (failure === 'missing') p.state.deletedKeys = [];
    if (failure === 'partial') p.state.badResponse = () => Response.json({ success: false, errors: [{ code: 10007 }], result: null });
    if (failure === 'invalid') p.state.badResponse = () => Response.json({ success: true, errors: [{ code: 10007 }], result: [] });
    if (failure === 'denied') p.state.badResponse = () => new Response(null, { status: 403 });
    await assert.rejects(removeDeletionBucket(snapshot, 'synthetic', p.transport));
    assert.equal(p.state.writes.length, 1); assert.ok(p.state.writes[0].path.endsWith('/objects'));
    assert.equal(p.state.buckets.length, 1);
  }
});

test('R2 object keys remain JSON data, never paths or prefix jobs', async () => {
  const p = provider(); p.state.entries = [entry('folder/邮件?prefix=&/#.eml')];
  const snapshot = await p.inspect(); await removeDeletionBucket(snapshot, 'synthetic', p.transport);
  assert.deepEqual(JSON.parse(p.state.writes[0].body), ['folder/邮件?prefix=&/#.eml']);
  assert.ok(p.state.writes[0].path.endsWith('/objects')); assert.equal(p.state.writes.length, 2);
});
