import { readJson } from './connections-provider.mjs';
import { deploymentDeclaration, connectionReference } from './deployment-contract.mjs';
import { sbaDigest, requireSba, exactSba, canonicalSba } from './sba-control.mjs';
import { discoverResources } from './resources.mjs';

const workerName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const compare = (a, b) => canonicalSba(a).localeCompare(canonicalSba(b), 'en');
export const importedId = value => typeof value === 'string' && /^im-[a-f0-9]{32}$/.test(value);
export function importInput(value) {
  exactSba(value, ['github', 'repository', 'sourceSha', 'cloudflare', 'components']);
  connectionReference(value.github); connectionReference(value.cloudflare);
  requireSba(typeof value.repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.repository));
  requireSba(typeof value.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(value.sourceSha));
  requireSba(value.components && typeof value.components === 'object' && !Array.isArray(value.components));
  return value;
}
const at = (value, path) => path.reduce((current, key) => current?.[key], value);
export function importComponents(application) {
  return deploymentDeclaration(application.declaration).targets.filter(target => target.kind === 'worker')
    .map(target => ({ key: target.path.join('.'), label: target.path.slice(0, -1).join('.') || target.path[0] }));
}
async function cloud(accountId, token, path, jurisdiction = '') {
  const transport = jurisdiction ? (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'cf-r2-jurisdiction': jurisdiction } }) : fetch;
  const response = await readJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, token, false, transport);
  requireSba(response.success === true && response.result !== undefined); return response.result;
}
function resourceBinding(binding) {
  requireSba(binding && typeof binding === 'object');
  if (binding.type === 'd1') {
    requireSba(typeof binding.id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(binding.id));
    return { kind: 'd1', remoteId: binding.id };
  }
  if (binding.type === 'kv_namespace') {
    requireSba(typeof binding.namespace_id === 'string' && /^[a-f0-9]{32}$/.test(binding.namespace_id));
    return { kind: 'kv', remoteId: binding.namespace_id };
  }
  if (binding.type === 'r2_bucket') {
    requireSba(typeof binding.bucket_name === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(binding.bucket_name));
    requireSba(binding.jurisdiction === undefined || ['', 'default', 'eu', 'us', 'fedramp', 'fedramp-high'].includes(binding.jurisdiction));
    return { kind: 'r2', remoteId: binding.bucket_name, jurisdiction: binding.jurisdiction ?? '' };
  }
  return null;
}

// Read provider-owned metadata only. Never fetch a Worker URL, secret value, KV
// value, database row, or application code; the declaration SHA is not the live SHA.
export async function inspectImported(owner, application, accountId, token, components, connections = null, legacy = null) {
  requireSba(/^[a-f0-9]{64}$/.test(owner) && /^[a-f0-9]{32}$/.test(accountId));
  const expected = importComponents(application).sort(compare); requireSba(expected.length > 0 && expected.length <= 8);
  exactSba(components, expected.map(component => component.key));
  const names = Object.values(components); requireSba(names.every(workerName) && new Set(names).size === names.length);
  const observed = [], resources = new Map();
  for (const component of expected) {
    const name = components[component.key], settings = await cloud(accountId, token, `/workers/scripts/${name}/settings`);
    requireSba(Array.isArray(settings.bindings) && settings.bindings.length <= 128);
    const bindings = [];
    for (const binding of settings.bindings) {
      const resource = resourceBinding(binding); if (!resource) continue;
      requireSba(typeof binding.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(binding.name));
      const key = `${resource.kind}/${resource.jurisdiction ?? ''}/${resource.remoteId}`;
      if (!resources.has(key)) resources.set(key, { ...resource, accountId, name: resource.remoteId, bindings: [] });
      resources.get(key).bindings.push({ worker: name, binding: binding.name });
      bindings.push({ name: binding.name, kind: resource.kind, remoteId: resource.remoteId });
    }
    requireSba(new Set(bindings.map(row => row.name)).size === bindings.length);
    observed.push({ key: component.key, label: component.label, name, bindings: bindings.sort(compare), domains: [] });
  }
  requireSba(resources.size <= 24);
  const domains = await cloud(accountId, token, '/workers/domains'); requireSba(Array.isArray(domains) && domains.length <= 1000);
  for (const domain of domains) {
    const component = observed.find(row => row.name === domain.service); if (!component) continue;
    requireSba(typeof domain.hostname === 'string' && domain.hostname.length <= 253 && /^[a-z0-9.-]+$/.test(domain.hostname));
    component.domains.push('https://' + domain.hostname);
  }
  for (const component of observed) component.domains = [...new Set(component.domains)].sort();
  for (const resource of resources.values()) {
    if (resource.kind === 'd1') {
      const database = await cloud(accountId, token, '/d1/database/' + resource.remoteId);
      requireSba(database.uuid === resource.remoteId && label(database.name));
      resource.name = database.name;
    }
    if (resource.kind === 'r2') {
      const bucket = await cloud(accountId, token, '/r2/buckets/' + resource.remoteId, resource.jurisdiction);
      requireSba(bucket.name === resource.remoteId);
    }
    resource.bindings.sort(compare);
  }
  const kv = [...resources.values()].filter(row => row.kind === 'kv');
  if (kv.length) {
    let cursor = '', pages = 0; const pending = new Map(kv.map(row => [row.remoteId, row]));
    do {
      requireSba(++pages <= 250); const listing = await discoverResources(accountId, token, 'kv', cursor);
      for (const item of listing.items) if (pending.has(item.id)) { pending.get(item.id).name = item.name; pending.delete(item.id); }
      cursor = listing.next ?? '';
    } while (cursor && pending.size);
    requireSba(pending.size === 0);
  }
  for (const kind of new Set(application.declaration.resources.map(row => row.kind))) {
    requireSba([...resources.values()].filter(row => row.kind === kind).length >= application.declaration.resources.filter(row => row.kind === kind).length);
  }
  const targets = [...names.map(value => ({ kind: 'worker', value })), ...observed.flatMap(row => row.domains.map(value => ({ kind: 'domain', value })))].sort(compare);
  requireSba(targets.length <= 32);
  const id = 'im-' + (await sbaDigest({ owner, accountId, workers: [...names].sort() })).slice(0, 32);
  if (legacy) {
    // Old provenance remains a separate record. It does not certify today's code.
    requireSba(legacy.request.repository === application.repository && legacy.request.applicationId === application.manifest.id);
    for (const target of application.declaration.targets) requireSba(targets.some(row => row.kind === target.kind && row.value === at(legacy.request.configuration, target.path)));
    for (const declared of application.declaration.resources) requireSba([...resources.values()].some(row => row.kind === declared.kind && row.remoteId === at(legacy.request.configuration, declared.idPath)));
  }
  const instance = { id, action: 'import', accountId, environment: legacy?.request.environment ?? null, connections,
    application: { id: application.manifest.id, name: application.manifest.name, repository: application.repository, version: null, sourceSha: null,
      definitionSha: application.sourceSha }, resources: Object.fromEntries([...resources.values()].sort(compare).map((row, i) => ['resource' + i, row])), targets };
  const stable = { instance, components: observed, definition: { repository: application.repository, sourceSha: application.sourceSha },
    provenance: legacy ? { type: 'legacy-task', taskId: legacy.request.taskId, runId: legacy.runId, sourceSha: legacy.request.sourceSha,
      applicationVersion: legacy.request.applicationVersion, status: legacy.status, result: legacy.result ?? null } : { type: 'provider-discovery' } };
  requireSba(importKeys(stable).length <= 64);
  const digest = await sbaDigest(stable);
  return { ...stable, digest, observedAt: Date.now(), id };
}

export function importKeys(candidate) {
  return [...new Set([...Object.values(candidate.instance.resources).flatMap(row => [row.remoteId, row.name]), ...candidate.instance.targets.map(row => row.value)])].sort();
}
export function sameImport(left, right) { return canonicalSba(importKeys(left)) === canonicalSba(importKeys(right)); }
