import { digest } from './execution/plan.mjs';
const repositories = { gateway: 'Gateway', platform: 'Platform', assetlibrary: 'AssetLibrary', rauthy: 'rauthy', crow: 'Crow' };
const components = { gateway: ['gateway'], platform: ['core-migrate', 'gateway-domain-migrate', 'account-domain-migrate', 'core', 'account-api', 'account-worker', 'worker', 'executor', 'web'], assetlibrary: ['api', 'web'], rauthy: ['identity'], crow: ['query-api'] };
const productGaps = {
  gateway: ['runtime-mode-and-dependency-profile-unselected', 'business-routing-acceptance-missing'],
  platform: ['multi-component-execution-contract-missing', 'migration-and-data-rollback-policy-missing', 'rauthy-business-integration-unverified'],
  assetlibrary: ['lightweight-runtime-topology-unverified', 'object-storage-and-worker-requirements-unresolved'],
  rauthy: ['database-mode-and-backup-restore-unverified', 'tls-issuer-and-login-acceptance-missing'],
  crow: ['independent-read-only-query-runtime-missing'],
};
const kinds = new Set(['database', 'cache', 'volume', 'identity', 'object-store', 'storage-choice', 'tls-domain', 'read-only-source', 'external-service']);
const identifier = /^[a-z][a-z0-9-]{0,47}$/;
const reject = () => { throw new Error('invalid owned-service catalog'); };
const check = condition => { if (!condition) reject(); };
function exact(value, keys) {
  check(value && Object.getPrototypeOf(value) === Object.prototype);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  check(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
}
function unique(values, max, pattern = identifier) { check(Array.isArray(values) && values.length <= max && values.every(v => typeof v === 'string' && pattern.test(v)) && new Set(values).size === values.length); }
function path(value) { check(value === null || (typeof value === 'string' && value.length <= 160 && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) && !value.split('/').some(p => p === '.' || p === '..'))); }
const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Static source declarations and unresolved requirements, NOT authenticated live
// inventory. Never returns an executable manifest, credentials or commands.
export function inspectOwnedCatalog(input) {
  exact(input, ['version', 'kind', 'products']);
  check(input.version === 1 && input.kind === 'owned-service-input-catalog' && Array.isArray(input.products) && input.products.length === 5);
  const seen = new Set();
  const normalized = structuredClone(input);
  for (const p of normalized.products) {
    exact(p, ['id', 'selected', 'source', 'components', 'dependencies']);
    check(typeof p.id === 'string' && Object.hasOwn(repositories, p.id) && !seen.has(p.id)); seen.add(p.id);
    check(typeof p.selected === 'boolean' && (p.id === 'crow' || p.selected));
    exact(p.source, ['repository', 'commit']);
    check(p.source.repository === `aiaimimi0920/${repositories[p.id]}` && typeof p.source.commit === 'string' && /^[a-f0-9]{40}$/.test(p.source.commit));
    check(Array.isArray(p.components) && Array.isArray(p.dependencies) && p.dependencies.length <= 16);
    unique(p.components.map(c => c?.id), 16); unique(p.dependencies.map(d => d?.id), 16);
    check([...p.components.map(c => c.id)].sort().join(',') === [...components[p.id]].sort().join(','));
    const dependencyIds = new Set(p.dependencies.map(d => d.id));
    for (const d of p.dependencies) {
      exact(d, ['id', 'kind', 'secretRefs', 'binding']); check(kinds.has(d.kind) && d.binding === null);
      unique(d.secretRefs, 16, /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,47}$/); d.secretRefs.sort(sort);
    }
    const byId = new Map(p.components.map(c => [c.id, c]));
    for (const c of p.components) {
      exact(c, ['id', 'kind', 'sourcePath', 'dependsOn', 'requires', 'health', 'binding']);
      check(c.kind === (c.id.endsWith('-migrate') ? 'migration' : 'service') && c.binding === null); path(c.sourcePath);
      unique(c.dependsOn, 16); unique(c.requires, 16);
      check(c.dependsOn.every(id => byId.has(id)) && c.requires.every(id => dependencyIds.has(id)));
      if (c.health !== null) {
        exact(c.health, ['liveness', 'readiness']);
        for (const value of Object.values(c.health)) check(value === null || (typeof value === 'string' && /^\/[a-z][a-z0-9/-]{0,63}$/.test(value)));
      }
      c.dependsOn.sort(sort); c.requires.sort(sort);
    }
    if (p.id === 'platform') {
      for (const [id, required] of [['gateway-domain-migrate', 'core-migrate'], ['account-domain-migrate', 'gateway-domain-migrate'], ['core', 'core-migrate'], ['account-api', 'account-domain-migrate'], ['account-worker', 'account-domain-migrate'], ['worker', 'core-migrate'], ['executor', 'core-migrate']]) check(byId.get(id).dependsOn.includes(required));
    }
    const active = new Set(), done = new Set();
    function visit(id) { check(!active.has(id)); if (done.has(id)) return; active.add(id); for (const next of byId.get(id).dependsOn) visit(next); active.delete(id); done.add(id); }
    for (const id of byId.keys()) visit(id);
    p.components.sort((a, b) => sort(a.id, b.id)); p.dependencies.sort((a, b) => sort(a.id, b.id));
  }
  normalized.products.sort((a, b) => sort(a.id, b.id));
  const rows = normalized.products.map(p => {
    const reasons = p.selected ? [
      ...productGaps[p.id], 'source-build-provenance-and-image-digest-unbound', 'dependency-inventory-incomplete',
      'authenticated-resolver-and-target-ownership-missing', 'durable-control-plane-and-human-approval-unbound',
      ...p.components.flatMap(c => [`component:${c.id}:test-and-production-resource-unbound`, ...(c.sourcePath === null ? [`component:${c.id}:startup-evidence-missing`] : []), ...(c.kind === 'service' && !c.health?.readiness ? [`component:${c.id}:readiness-contract-unverified`] : [])]),
      ...p.dependencies.map(d => `dependency:${d.id}:unbound`),
    ].sort(sort) : [];
    return { id: p.id, status: p.selected ? 'blocked' : 'not-selected', reasons };
  });
  return { version: 1, kind: 'owned-service-adapter-input-check', executionReady: false, executable: false,
    sourceEvidence: 'declared-repository-paths-not-runtime-verification', catalogDigest: digest(normalized), catalog: normalized, rows };
}
