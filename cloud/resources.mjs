import { readJson } from './connections-provider.mjs';
import { connectionId } from './connections-contract.mjs';
const requireValue = v => { if (!v) throw new Error('resource rejected'); };
export function resourceInput(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const keys = value.action === 'discover' ? ['action','connectionId','kind','cursor'] : ['action','connectionId','kind','listingId','resourceId'];
  requireValue(Object.keys(value).sort().join() === keys.sort().join()); connectionId(value.connectionId);
  requireValue(['d1','kv','r2'].includes(value.kind));
  if (value.action === 'discover') {
    requireValue(typeof value.cursor === 'string' && value.cursor.length <= 512);
    requireValue(value.kind === 'r2' ? (value.cursor === '' || validResourceId('r2',value.cursor)) : /^(?:|[1-9][0-9]{0,4})$/.test(value.cursor));
  } else { requireValue(value.action === 'register'); connectionId(value.listingId); requireValue(validResourceId(value.kind, value.resourceId)); }
  return value;
}
export function validResourceId(kind, id) {
  return typeof id === 'string' && (kind === 'd1' ? /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) : kind === 'kv' ? /^[a-f0-9]{32}$/.test(id) : /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(id));
}
export async function discoverResources(account, token, kind, cursor, transport) {
  requireValue(/^[a-f0-9]{32}$/.test(account) && ['d1','kv','r2'].includes(kind));
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const page = Number(cursor || '1');
  const suffix = kind === 'r2' ? `/r2/buckets?per_page=100&order=name${cursor ? '&start_after=' + encodeURIComponent(cursor) : ''}` : `/${kind === 'd1' ? 'd1/database' : 'storage/kv/namespaces'}?per_page=100&page=${page}`;
  const body = await readJson(base + suffix, token, false, transport);
  requireValue(body.success === true);
  const values = kind === 'r2' ? body.result?.buckets : body.result;
  requireValue(Array.isArray(values) && values.length <= 100);
  const items = values.map(row => {
    const id = kind === 'd1' ? row.uuid : kind === 'kv' ? row.id : row.name;
    const name = kind === 'kv' ? row.title : row.name;
    requireValue(validResourceId(kind,id) && typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\u0000-\u001f]/.test(name));
    return { id, name };
  });
  requireValue(new Set(items.map(x => x.id)).size === items.length);
  let next = null;
  if (kind === 'r2') {
    requireValue(items.every((item,i) => item.id > (i ? items[i-1].id : cursor)));
    if (items.length === 100) next = items.at(-1).id;
  } else {
    if (body.result_info?.page !== undefined) requireValue(body.result_info.page === page);
    // 供应商未保证 total_pages；满页继续显式翻页，空页是可靠终点。
    if (items.length === 100) { requireValue(page < 99999); next = String(page + 1); }
  }
  return { items, next };
}
