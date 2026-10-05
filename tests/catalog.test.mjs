import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogName, catalogInput, serviceInput, CatalogError } from '../cloud/catalog-contract.mjs';

test('catalog names normalize Unicode without interpreting names as code or addresses', () => {
  assert.equal(catalogName('  测试服务器  '), '测试服务器');
  assert.equal(catalogName('Cafe\u0301'), 'Café');
  assert.equal(catalogName('😀'.repeat(64)), '😀'.repeat(64));
  assert.equal(catalogName('<script>alert(1)</script>'), '<script>alert(1)</script>');
  for (const name of [null, 12, '', '   ', 'a'.repeat(65), '😀'.repeat(65), 'a\u0000b', 'a\u200bb', 'a\n中', '\ud800']) assert.throws(() => catalogName(name), CatalogError);
});

test('service metadata allows only fixed fields and immutable server references', () => {
  const create = { id: randomUUID(), revision: 0, action: 'create', serverId: randomUUID(), name: ' 网关 ' };
  assert.deepEqual(serviceInput(create), { ...create, name: '网关' });
  const rename = { id: randomUUID(), revision: 1, action: 'rename', serviceId: randomUUID(), name: '新名称' };
  assert.deepEqual(serviceInput(rename), rename);
  const archive = { id: randomUUID(), revision: 2, action: 'archive', serviceId: rename.serviceId };
  assert.deepEqual(serviceInput(archive), archive);
  for (const value of [null, [], {}, { ...create, serverId: 'pc2-test' }, { ...create, serviceId: randomUUID() },
    { ...create, revision: -1 }, { ...create, revision: 1.1 }, { ...create, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...create, owner: 'other' }, { ...create, state: 'ready' }, { ...create, command: 'deploy' }, { ...create, product: 'gateway' },
    { ...create, id: create.id.toUpperCase() }, { ...create, name: 'x'.repeat(65) }, { ...rename, serverId: create.serverId },
    { ...archive, name: 'extra' }, { ...archive, serviceId: 'unknown' }, { ...archive, action: 'deploy' }]) assert.throws(() => serviceInput(value), CatalogError);
});

test('catalog mutations accept only exact action fields and service-generated ID references', () => {
  const create = { id: randomUUID(), revision: 0, action: 'create', name: ' 主机 ' };
  assert.deepEqual(catalogInput(create), { ...create, name: '主机' });
  const serverId = randomUUID();
  assert.deepEqual(catalogInput({ ...create, action: 'rename', serverId }), { ...create, action: 'rename', serverId, name: '主机' });
  const archive = { id: randomUUID(), revision: 3, action: 'archive', serverId };
  assert.deepEqual(catalogInput(archive), archive);
  for (const value of [null, [], {}, { ...create, id: 'pc2-test' }, { ...create, id: create.id.toUpperCase() },
    { ...create, revision: -1 }, { ...create, revision: 0.5 }, { ...create, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...create, action: 'deploy' }, { ...create, serverId }, { ...create, owner: 'self' },
    { ...create, address: 'https://example.invalid' }, { ...create, action: 'rename' }, { ...archive, name: 'unexpected' },
    { ...archive, serverId: 'unknown' }]) assert.throws(() => catalogInput(value), CatalogError);
});
