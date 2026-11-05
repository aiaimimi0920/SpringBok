import test from 'node:test';
import assert from 'node:assert/strict';
import { r2DeletionFixture, bucketNames, object } from './service-deletion-r2-fixture.mjs';

test('R2 deletion reviews metadata, removes only approved objects after Workers, verifies both buckets and persists once', async () => {
  const s = await r2DeletionFixture();
  try {
    const response = await s.review(); assert.equal(response.status, 200, response.text);
    const plan = response.json(), buckets = plan.plan.resources.filter(row => row.kind === 'r2');
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0].objects.count, 1); assert.equal(buckets[0].objects.bytes, 12);
    assert.match(buckets[0].objects.digest, /^[a-f0-9]{64}$/);
    assert.ok(!response.text.includes('private/message.eml'), 'private object keys are not in the public plan');
    assert.equal(s.live.deletes.length, 0);
    const done = await s.remove(plan); assert.equal(done.status, 200, done.text); assert.equal(done.json().status, 'deleted', done.text);
    assert.deepEqual(s.live.deletes, ['/workers/domains/' + 'd'.repeat(32), '/workers/scripts/test-worker', '/d1/database/' + s.resource.remoteId,
      '/r2/buckets/' + bucketNames[0] + '/objects', '/r2/buckets/' + bucketNames[0], '/r2/buckets/' + bucketNames[1]]);
    assert.equal(s.r2.objects.size, 0);
    await s.f.restart();
    assert.equal((await s.remove(plan)).json().status, 'deleted'); assert.equal(s.live.deletes.length, 6);
    const state = (await s.service('service-state', { instanceId: s.initial.taskId, reconcile: true })).json();
    assert.equal(state.status, 'deleted'); assert.equal(state.history.length, 1);
  } finally { await s.f.close(); }
});

test('R2 shared references, public access, locks, notifications, unreadable or truncated objects reject before any writes', async () => {
  const s = await r2DeletionFixture();
  try {
    for (const [key, value, reset] of [['sharedWorker', true, false], ['sharedPages', true, false], ['public', true, false],
      ['locks', [{ enabled: true }], []], ['queues', [{ queueId: 'external' }], []], ['domains', [{ domain: 'other.example.invalid' }], []],
      ['denied', true, false], ['truncated', true, false]]) {
      s.r2[key] = value;
      assert.equal((await s.review()).status, 409, key); assert.equal(s.live.deletes.length, 0, key);
      s.r2[key] = reset;
    }
    const response = await s.review(); assert.equal(response.status, 200, response.text);
    s.r2.unknownPages = true;
    const risk = await s.review(); assert.equal(risk.status, 200, risk.text);
    assert.equal(risk.json().plan.unverifiedReferences.some(row => row.kind === 'r2'), true);
    assert.equal((await s.remove(risk.json())).status, 409); assert.equal(s.live.deletes.length, 0);
  } finally { await s.f.close(); }
});

test('changed object identity, byte size or recreated bucket invalidates prior consent without cloud writes', async () => {
  const s = await r2DeletionFixture();
  try {
    const response = await s.review(); assert.equal(response.status, 200, response.text); const plan = response.json();
    for (const change of [() => s.r2.objects.get(bucketNames[0])[0].size++, () => s.r2.objects.get(bucketNames[0])[0].etag = 'b'.repeat(32),
      () => s.r2.createdAt = '2026-11-06T01:00:00.000Z']) {
      change(); assert.equal((await s.remove(plan)).status, 409); assert.equal(s.live.deletes.length, 0);
    }
  } finally { await s.f.close(); }
});

for (const failure of ['lost', 'partial', 'lateObject']) test(`R2 ${failure} stays unknown and cannot replay after restart`, async () => {
  const s = await r2DeletionFixture();
  try {
    const response = await s.review(); assert.equal(response.status, 200, response.text); const plan = response.json();
    s.r2[failure] = true;
    const done = (await s.remove(plan)).json(); assert.equal(done.status, 'delete-unknown');
    assert.equal(done.resources.find(row => row.kind === 'r2' && row.name === bucketNames[0]).status, 'unknown');
    assert.equal(s.r2.objects.has(bucketNames[0]), true); assert.equal(s.r2.objects.has(bucketNames[1]), true);
    if (failure === 'lateObject') assert.deepEqual(s.r2.objects.get(bucketNames[0]), [object('late-object')]);
    const count = s.live.deletes.length; await s.f.restart();
    assert.equal((await s.remove(plan)).json().status, 'delete-unknown'); assert.equal(s.live.deletes.length, count);
    assert.equal((await s.review()).status, 409);
  } finally { await s.f.close(); }
});
