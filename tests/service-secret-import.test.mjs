import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationSecretImport } from '../public/cloud-admin/service-secrets.js';

const names = ['APP_COOKIE_SECRET', 'APP_STORAGE_KEY'];
const valid = { APP_COOKIE_SECRET: 'synthetic-cookie', APP_STORAGE_KEY: 'synthetic-storage' };
test('application secret JSON import matches the exact declared set without normalizing values', () => {
  assert.deepEqual(parseApplicationSecretImport(JSON.stringify(valid), names), valid);
  const unicode = { ...valid, APP_COOKIE_SECRET: '密'.repeat(170) + '  ' };
  assert.deepEqual(parseApplicationSecretImport('\ufeff' + JSON.stringify(unicode), names), unicode);
});
test('invalid imports fail with a fixed message that never includes input or parser details', () => {
  const invalid = [null, [], 'synthetic-private-value', 1, {},
    { APP_COOKIE_SECRET: 'synthetic-private-value' }, { ...valid, EXTRA_SECRET: 'synthetic-private-value' },
    { ...valid, APP_STORAGE_KEY: '' }, { ...valid, APP_STORAGE_KEY: 2 },
    { ...valid, APP_STORAGE_KEY: '密'.repeat(171) }, { ...valid, APP_STORAGE_KEY: 'x'.repeat(513) },
    ...['\n', '\r', '\t', '\0', '\x7f'].map(c => ({ ...valid, APP_STORAGE_KEY: 'synthetic-private-value' + c }))];
  for (const value of invalid) assert.throws(() => parseApplicationSecretImport(JSON.stringify(value), names),
    { message: '秘密文件格式或内容不匹配' });
  for (const text of ['{synthetic-private-value', ' '.repeat(32769)])
    assert.throws(() => parseApplicationSecretImport(text, names), { message: '秘密文件格式或内容不匹配' });
});
test('secret import accepts the vault byte limit and rejects reserved or inherited names', () => {
  assert.equal(parseApplicationSecretImport(JSON.stringify({ APP_COOKIE_SECRET: 'x'.repeat(512), APP_STORAGE_KEY: 'ok' }), names).APP_COOKIE_SECRET.length, 512);
  assert.throws(() => parseApplicationSecretImport('{"__proto__":"synthetic-private-value"}', names));
  assert.throws(() => parseApplicationSecretImport('{"constructor":"synthetic-private-value"}', names));
});
