import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceAbsent } from '../cloud/service-deletion-provider.mjs';

const row = { kind: 'd1', accountId: 'a'.repeat(32), remoteId: '87654321-1234-1234-1234-123456789abc', name: 'test-database' };
const missing = { success: false, result: null, errors: [{ code: 7404, message: 'Database not found' }] };
function transport(body, status = 404) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    return Response.json(body, { status });
  };
  return { fetch, requests };
}
test('D1 deletion absence reads its immutable UUID, not a transient account-wide count', async () => {
  const live = transport(missing);
  assert.equal(await resourceAbsent(row, 'test-token', live.fetch), true);
  assert.deepEqual(live.requests, [{ url: 'https://api.cloudflare.com/client/v4/accounts/' + row.accountId + '/d1/database/' + row.remoteId, method: 'GET' }]);
});
test('matching live D1 is present, not a successful deletion', async () => {
  const live = transport({ success: true, errors: [], result: { uuid: row.remoteId, name: row.name } }, 200);
  assert.equal(await resourceAbsent(row, 'test-token', live.fetch), false);
});
for (const [label, body, status] of [
  ['permission denied', { success: false, errors: [{ code: 10000 }], result: null }, 403],
  ['unrelated 404', { ...missing, errors: [{ code: 10000 }] }, 404],
  ['missing result', { success: false, errors: [{ code: 7404 }] }, 404],
  ['unexpected success', { ...missing, success: true }, 404],
  ['multiple errors', { ...missing, errors: [{ code: 7404 }, { code: 10000 }] }, 404],
  ['wrong identity', { success: true, errors: [], result: { uuid: row.remoteId, name: 'replacement-database' } }, 200],
]) test('D1 absence rejects ' + label, async () => {
  const live = transport(body, status);
  await assert.rejects(resourceAbsent(row, 'test-token', live.fetch));
  assert.equal(live.requests.length, 1);
  assert.equal(live.requests[0].method, 'GET');
});
