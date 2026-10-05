export const MAX_SERVERS = 64;
export const MAX_SERVICES = 256;
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

export function serviceInput(value) {
  requireCatalog(value && Object.getPrototypeOf(value) === Object.prototype && ['create', 'rename', 'archive'].includes(value.action));
  const keys = ['id', 'revision', 'action', value.action === 'create' ? 'serverId' : 'serviceId', ...(value.action !== 'archive' ? ['name'] : [])].sort();
  const actual = Object.keys(value).sort();
  requireCatalog(actual.length === keys.length && actual.every((key, index) => key === keys[index]));
  requireCatalog(isUuid(value.id) && Number.isSafeInteger(value.revision) && value.revision >= 0);
  const reference = value.action === 'create' ? 'serverId' : 'serviceId';
  requireCatalog(isUuid(value[reference]));
  return { id: value.id, revision: value.revision, action: value.action, [reference]: value[reference],
    ...(value.action !== 'archive' ? { name: catalogName(value.name) } : {}) };
}

export function catalogReceipt(entry, revision, servicesAllowed = true) {
  const stored = JSON.parse(entry.input_json), service = stored?.resource === 'service';
  requireCatalog(!service || servicesAllowed);
  const { resource, ...value } = service ? stored : { resource: null, ...stored };
  const input = service ? serviceInput(value) : catalogInput(stored);
  requireCatalog(entry.request_id === input.id && entry.input_json === JSON.stringify(service ? { resource, ...input } : input));
  const result = JSON.parse(entry.result_json), kind = service ? 'service' : 'server';
  requireCatalog(result && Object.keys(result).sort().join(',') === ['id', 'revision', kind].sort().join(',') && result.id === input.id && result.revision === input.revision + 1 && result.revision <= revision);
  const record = result[kind], fields = ['id', 'name', 'state', 'createdAt', 'updatedAt', ...(service ? ['serverId'] : [])];
  requireCatalog(record && Object.keys(record).sort().join(',') === fields.sort().join(',') && isUuid(record.id) && catalogName(record.name) === record.name && record.state === (input.action === 'archive' ? 'archived' : 'draft') && Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.updatedAt) && record.createdAt >= 0 && record.updatedAt >= record.createdAt);
  if (input.action !== 'create') requireCatalog(record.id === input[service ? 'serviceId' : 'serverId']);
  if (input.action !== 'archive') requireCatalog(record.name === input.name);
  if (service) requireCatalog(isUuid(record.serverId) && (input.action !== 'create' || record.serverId === input.serverId));
  return result;
}
