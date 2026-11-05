import assert from 'node:assert/strict';
import { serviceFixture } from './service-fixture.mjs';
import { deletionProvider } from './service-deletion-fixture.mjs';

export const bucketNames = ['test-email-inbox', 'test-email-outbox'];
export const object = (key, size = 12) => ({ key, size, etag: 'a'.repeat(32), last_modified: '2026-11-06T00:00:00.000Z' });
export async function r2DeletionFixture(suite) {
  const s = suite ?? await serviceFixture();
  try {
    s.state.declaration = structuredClone(s.state.declaration);
    for (const [index, bucket] of bucketNames.entries()) {
      s.state.resources = { success: true, result: { buckets: [{ name: bucket }] } };
      const found = (await s.f.call('/api/admin/resources', { ...s.session, body: { action: 'discover', connectionId: s.input.cloudflare.id, kind: 'r2', cursor: '' } })).json();
      const registered = await s.f.call('/api/admin/resources', { ...s.session, body: { action: 'register', connectionId: s.input.cloudflare.id, kind: 'r2', listingId: found.id, resourceId: bucket } });
      assert.equal(registered.status, 200, registered.text);
      const row = registered.json().resource, key = 'bucket' + index;
      s.state.declaration.resources.push({ key, label: '邮件存储', kind: 'r2', idPath: [key], namePath: null });
      s.input.resources[key] = { id: row.id, revision: row.revision };
    }
    s.state.resources = null;
    const initial = (await s.service('plan', s.input)).json();
    assert.equal((await s.submit(initial)).status, 200);
    s.receipt(await (await s.machine()).json());
    await s.service('service-state', { instanceId: initial.taskId, reconcile: true });
    const live = deletionProvider(s), prior = s.state.provider;
    const r2 = { objects: new Map(bucketNames.map((name, index) => [name, index ? [] : [object('private/message.eml')]])),
      createdAt: '2026-11-06T00:00:00.000Z', sharedWorker: false, sharedPages: false, unknownPages: false,
      truncated: false, denied: false, lost: false, partial: false, lateObject: false, locks: [], queues: [], domains: [], public: false };
    const ok = (result, result_info) => Response.json({ success: true, errors: [], result, ...(result_info ? { result_info } : {}) });
    s.state.provider = async (request, context) => {
      const url = new URL(request.url), path = url.pathname.split('/accounts/' + 'a'.repeat(32))[1];
      if (!path) return prior(request, context);
      if (request.method === 'GET') {
        if (path.endsWith('/settings')) {
          const response = await prior(request, context), body = await response.json();
          if (path.includes('/test-worker/') || r2.sharedWorker) body.result.bindings.push(...bucketNames.map(bucket_name => ({ type: 'r2_bucket', bucket_name, name: bucket_name })));
          else body.result.bindings.push({ type: 'r2_bucket', bucket_name: bucketNames[0], jurisdiction: 'eu', name: 'UNRELATED_EU_BUCKET' });
          return Response.json(body);
        }
        if (path === '/pages/projects' && (r2.sharedPages || r2.unknownPages)) return ok([{ name: 'other-pages', deployment_configs: { production: { r2_buckets: r2.sharedPages ? { MAIL: { name: bucketNames[0] } } : {} } } }]);
        if (path === '/pages/projects/other-pages/deployments' && r2.unknownPages) return ok([{ id: '87654321-1234-1234-1234-123456789abc', uses_functions: true, d1_databases: {} }]);
        if (path === '/r2/buckets') return ok({ buckets: [...r2.objects.keys()].map(name => ({ name, creation_date: r2.createdAt, jurisdiction: 'default' })) });
        const bucket = path.split('/')[3];
        if (path.startsWith('/r2/buckets/') && r2.objects.has(bucket)) {
          if (r2.denied) return new Response(null, { status: 403 });
          if (path.endsWith('/objects')) return ok(r2.objects.get(bucket), { is_truncated: r2.truncated });
          if (path.endsWith('/lock')) return ok({ rules: r2.locks });
          if (path.endsWith('/domains/custom')) return ok({ domains: r2.domains });
          if (path.endsWith('/domains/managed')) return ok({ enabled: r2.public });
        }
        if (path.startsWith('/event_notifications/r2/')) return ok({ queues: r2.queues });
      }
      if (request.method === 'DELETE' && path.startsWith('/r2/buckets/')) {
        live.deletes.push(path);
        const bucket = path.split('/')[3];
        if (path.endsWith('/objects')) {
          const keys = await request.json();
          assert.ok(Array.isArray(keys) && keys.length > 0 && keys.length <= 1000);
          r2.objects.set(bucket, r2.objects.get(bucket).filter(row => !keys.includes(row.key)));
          if (r2.lateObject) r2.objects.get(bucket).push(object('late-object'));
          if (r2.lost) return new Response(null, { status: 503 });
          if (r2.partial) return Response.json({ success: false, result: null, errors: [{ code: 10007 }] });
          return ok(keys.map(key => ({ key })));
        }
        assert.equal(r2.objects.get(bucket).length, 0);
        r2.objects.delete(bucket);
        return ok({});
      }
      return prior(request, context);
    };
    const body = { instanceId: initial.taskId, previousTaskId: initial.taskId };
    const review = () => s.service('delete-plan', body);
    const remove = plan => s.service('delete-submit', { ...plan, acceptUnverifiedReferences: false });
    return { ...s, initial, live, r2, review, remove };
  } catch (error) { await s.f.close(); throw error; }
}
