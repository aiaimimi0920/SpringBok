export const MAX_SERVERS = 64;
export const MAX_CATALOG_REQUESTS = 1024;
export const isUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export class CatalogError extends Error {}
export function requireCatalog(condition) { if (!condition) throw new CatalogError('catalog request rejected'); }
export function catalogName(value) {
  requireCatalog(typeof value === 'string');
  const name = value.normalize('NFC').trim();
  requireCatalog([...name].length >= 1 && [...name].length <= 64 && new TextEncoder().encode(name).length <= 256 && !/\p{C}/u.test(name));
  return name;
}
export function catalogInput(value) {
  requireCatalog(value && Object.getPrototypeOf(value) === Object.prototype && ['create', 'rename', 'archive'].includes(value.action));
  const keys = ['id', 'revision', 'action', ...(value.action !== 'create' ? ['serverId'] : []), ...(value.action !== 'archive' ? ['name'] : [])];
  const actual = Object.keys(value).sort(); keys.sort();
  requireCatalog(actual.length === keys.length && actual.every((key, index) => key === keys[index]));
  requireCatalog(isUuid(value.id) && Number.isSafeInteger(value.revision) && value.revision >= 0);
  if (value.action !== 'create') requireCatalog(isUuid(value.serverId));
  return { id: value.id, revision: value.revision, action: value.action,
    ...(value.action !== 'create' ? { serverId: value.serverId } : {}),
    ...(value.action !== 'archive' ? { name: catalogName(value.name) } : {}) };
}
