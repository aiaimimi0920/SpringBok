import { readJson } from './connections-provider.mjs';
import { requireSba, canonicalSba } from './sba-control.mjs';

const endpoint = (account, path) => `https://api.cloudflare.com/client/v4/accounts/${account}${path}`;
const identity = row => `${row.accountId}/${row.kind}/${row.remoteId}`;
const sort = rows => rows.sort((a, b) => identity(a).localeCompare(identity(b), 'en'));
const name = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value);
export function deletionInventory(instance) {
  const rows = Object.values(instance.resources).map(r => ({ kind: r.kind, accountId: r.accountId, remoteId: r.remoteId, name: r.name }));
  for (const t of instance.targets) if (t.kind === 'worker') rows.push({ kind: 'worker', accountId: t.accountId ?? instance.accountId, remoteId: t.value, name: t.value });
  requireSba(rows.length > 0 && rows.length <= 32 && rows.some(r => r.kind === 'worker'));
  for (const r of rows) {
    requireSba(/^[a-f0-9]{32}$/.test(r.accountId) && typeof r.name === 'string' && r.name.length <= 256);
    requireSba(r.kind === 'worker' ? name(r.remoteId) : r.kind === 'd1' ? /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.remoteId) : r.kind === 'kv' && /^[a-f0-9]{32}$/.test(r.remoteId));
  }
  requireSba(new Set(rows.map(identity)).size === rows.length);
  return sort(rows);
}
async function list(account, token, path, transport) {
  const body = await readJson(endpoint(account, path), token, false, transport);
  requireSba(body.success === true && Array.isArray(body.result) && body.result.length <= 1000);
  requireSba(!body.result_info || (body.result_info.total_pages ?? 1) <= 1 && (body.result_info.total_count ?? body.result.length) <= body.result.length);
  return body.result;
}
function bindingIdentity(accountId, binding) {
  if (binding.type === 'd1') return identity({ accountId, kind: 'd1', remoteId: binding.id });
  if (binding.type === 'kv_namespace') return identity({ accountId, kind: 'kv', remoteId: binding.namespace_id });
  return null;
}
// 只检查元数据；不读取数据库内容、KV 值或 Worker secret。
export async function inspectDeletion(rows, tokens, transport = fetch) {
  const result = [], unverifiedReferences = [], storageIds = new Set(rows.filter(r => r.kind !== 'worker').map(r => `${r.kind}/${r.remoteId}`));
  for (const accountId of [...new Set(rows.map(r => r.accountId))].sort()) {
    const token = tokens[accountId], own = rows.filter(r => r.accountId === accountId), keys = new Set(own.map(identity));
    const workers = await list(accountId, token, '/workers/scripts', transport);
    requireSba(workers.length <= 100 && workers.every(w => name(w.id)));
    const selected = new Set(own.filter(r => r.kind === 'worker').map(r => r.remoteId));
    const domains = await list(accountId, token, '/workers/domains', transport);
    for (const d of domains.filter(d => selected.has(d.service))) {
      requireSba(typeof d.id === 'string' && /^[a-f0-9]{32,64}$/.test(d.id) && typeof d.hostname === 'string' && /^[a-z0-9.-]{1,253}$/.test(d.hostname));
      result.push({ kind: 'domain', accountId, remoteId: d.id, name: d.hostname, worker: d.service, present: true });
    }
    for (const worker of workers) {
      const body = await readJson(endpoint(accountId, `/workers/scripts/${worker.id}/settings`), token, false, transport);
      requireSba(body.success === true && Array.isArray(body.result?.bindings) && body.result.bindings.length <= 128);
      for (const binding of body.result.bindings) {
        const key = bindingIdentity(accountId, binding);
        if (selected.has(worker.id)) {
          // 未登记的数据绑定不能随 Worker 被隐式销毁。
          requireSba(!['durable_object_namespace', 'r2_bucket'].includes(binding.type) && (!key || keys.has(key)));
        } else {
          requireSba(!key || !storageIds.has(key.slice(accountId.length + 1)));
          requireSba(!(binding.type === 'service' && selected.has(binding.service)) && !(binding.type === 'durable_object_namespace' && selected.has(binding.script_name)));
        }
      }
    }
    // Pages 的当前配置和保留部署也可能继续引用同一存储，不能只看 Worker 列表。
    const projects = await list(accountId, token, '/pages/projects?page=1', transport);
    for (const project of projects) {
      requireSba(name(project.name) && project.deployment_configs && typeof project.deployment_configs === 'object');
      const deployments = await list(accountId, token, `/pages/projects/${project.name}/deployments?page=1`, transport);
      // 实际 API 可返回绑定字段，但 OpenAPI 未保证；Functions 部署缺少字段时不能当空绑定。
      for (const [field, kind] of [['d1_databases', 'd1'], ['kv_namespaces', 'kv']]) {
        const unknown = deployments.filter(d => d.uses_functions !== false && !Object.hasOwn(d, field));
        requireSba(unknown.every(d => typeof d.id === 'string' && /^[a-f0-9-]{36}$/.test(d.id)));
        if (rows.some(r => r.kind === kind) && unknown.length) unverifiedReferences.push({ accountId, project: project.name, kind, deploymentIds: unknown.map(d => d.id).sort() });
      }
      for (const config of [...Object.values(project.deployment_configs), ...deployments]) {
        for (const [field, kind] of [['d1_databases', 'd1'], ['kv_namespaces', 'kv']]) {
          const bindings = config[field] ?? {}; requireSba(bindings && typeof bindings === 'object' && !Array.isArray(bindings));
          for (const binding of Object.values(bindings)) requireSba(typeof binding?.id === 'string' && !storageIds.has(`${kind}/${binding.id}`));
        }
      }
    }
    const databases = own.some(r => r.kind === 'd1') ? await list(accountId, token, '/d1/database?per_page=1000&page=1', transport) : [];
    const namespaces = own.some(r => r.kind === 'kv') ? await list(accountId, token, '/storage/kv/namespaces?per_page=1000&page=1', transport) : [];
    for (const row of own) {
      const live = row.kind === 'worker' ? workers.find(w => w.id === row.remoteId) : row.kind === 'd1' ? databases.find(d => d.uuid === row.remoteId) : namespaces.find(k => k.id === row.remoteId);
      if (live && row.kind !== 'worker') requireSba((live.name ?? live.title) === row.name);
      result.push({ ...row, present: !!live, ...(row.kind === 'worker' && live ? { modifiedAt: live.modified_on ?? null } : {}) });
    }
  }
  return { resources: sort(result), unverifiedReferences };
}
export async function resourceAbsent(row, token, transport = fetch) {
  const path = { worker: '/workers/scripts', domain: '/workers/domains', d1: '/d1/database?per_page=1000&page=1', kv: '/storage/kv/namespaces?per_page=1000&page=1' }[row.kind];
  const rows = await list(row.accountId, token, path, transport);
  return !rows.some(r => (row.kind === 'd1' ? r.uuid : r.id) === row.remoteId);
}
export async function removeResource(row, token, transport = fetch) {
  const path = { worker: '/workers/scripts/', domain: '/workers/domains/', d1: '/d1/database/', kv: '/storage/kv/namespaces/' }[row.kind];
  requireSba(path);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await transport(endpoint(row.accountId, path + encodeURIComponent(row.remoteId)), { method: 'DELETE', redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${token}` } });
    // Cloudflare 的 Worker/domain DELETE 可返回 2xx 空正文；成功仍以独立读回为准。
    await response.body?.cancel(); requireSba(response.status >= 200 && response.status < 300);
  } finally { clearTimeout(timer); }
}
export const sameDeletion = (a, b) => canonicalSba(a) === canonicalSba(b);
