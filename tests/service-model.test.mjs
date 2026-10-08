import test from 'node:test';
import assert from 'node:assert/strict';
import { boundResources, resourceMetrics, confirmedVersion, newerVersion, statusText } from '../public/cloud-admin/service-model.mjs';
test('service usage projects only bound unique resources, not account totals or allowances; missing remains unknown', () => {
  const instance = { connections: { cloudflare: { id: 'connection' } }, resources: { a: { kind: 'd1', name: 'db', remoteId: 'db' }, b: { kind: 'd1', name: 'db', remoteId: 'db' } }, targets: [{ kind: 'worker', value: 'worker' }] };
  assert.equal(boundResources(instance).length, 2);
  const usage = new Map([['connection/d1', { metrics: [{ id: 'storage', label: '存储', unit: 'bytes', periodLabel: '今日', allowance: { value: 5000000000 } }], samples: { db: { storage: { value: 1000000, complete: true } }, other: { storage: { value: 9000000, complete: true } } } }]]);
  assert.equal(resourceMetrics(instance, boundResources(instance)[0], usage)[0].text, '1 MB'); assert.equal(resourceMetrics(instance, boundResources(instance)[1], usage)[0].text, '—');
  assert.equal(Object.hasOwn(resourceMetrics(instance, boundResources(instance)[0], usage)[0], 'allowance'), false);
});
test('failed update keeps last confirmed version; unverified is never labeled business success', () => {
  assert.deepEqual(confirmedVersion({ job: { status: 'failed' }, instance: { previous: { sourceSha: 'old', applicationVersion: '1.0.0' } } }), { version: '1.0.0', sourceSha: 'old' });
  assert.equal(confirmedVersion({ job: { status: 'running' } }), null); assert.equal(statusText('deployed-unverified'), '已部署，待验证'); assert.equal(statusText('unknown'), '结果未确认');
  assert.equal(newerVersion('1.10.0','1.2.0'),true); for(const version of ['1.2.0','1.1.9','1.3.0-beta','01.3.0'])assert.equal(newerVersion(version,'1.2.0'),false);
});
test('identical resource names and IDs in different accounts use separate usage sources', () => {
  const instance={connections:{cloudflare:{id:'runtime'}},resources:{a:{kind:'r2',remoteId:'same',name:'same',accountId:'a',connectionId:'runtime'},b:{kind:'r2',remoteId:'same',name:'same',accountId:'b',connectionId:'storage'}}};
  const bound=boundResources(instance);assert.equal(bound.length,2);
  const usage=new Map([['storage/r2',{metrics:[{id:'storage',unit:'bytes'}],samples:{same:{storage:{value:2000000,complete:true}}}}]]);
  assert.equal(resourceMetrics(instance,bound[0],usage)[0].text,'—');assert.equal(resourceMetrics(instance,bound[1],usage)[0].text,'2 MB');
});
