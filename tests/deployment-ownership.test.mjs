import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyIdentities } from '../cloud/deployment-ownership.mjs';

test('legacy resource identities preserve nested field selection, order and duplicates', () => {
  assert.deepEqual(legacyIdentities({
    server: { name: 'worker', url: 'https://worker.example.invalid', label: 'not-an-identity' },
    resources: [{ id: 'database', kvId: 'namespace' }, { databaseId: 'database', bucket: 'storage', bucketName: 'storage' }],
    id: { nested: { name: 'nested-worker' } },
    ignored: ['plain-string', null, 17, false],
  }), ['worker', 'https://worker.example.invalid', 'database', 'namespace', 'database', 'storage', 'storage', 'nested-worker']);
});

test('legacy identity collection does not invent filtering or normalize existing values', () => {
  const long = 'x'.repeat(300);
  assert.deepEqual(legacyIdentities({ name: '', id: long, bucketName: 'Mixed-Case', url: 'not-a-url' }), ['', long, 'Mixed-Case', 'not-a-url']);
  for (const value of [undefined, null, false, 0, 'name', [], {}]) assert.deepEqual(legacyIdentities(value), []);
});
