import { createHash } from 'node:crypto';
import { validateManifest } from '../contract.mjs';

export const oid = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error('unexpected execution fields');
}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  throw new Error('configuration must be plain JSON');
}
export const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;

// Trusted harness inventory only. A future authenticated resolver must provide
// the COMPLETE resolved configuration, including default fields, without secrets.
// We never write these configurations or accept them through an HTTP/tool route.
export function releaseSpec(release) {
  exact(release, ['service', 'artifact', 'test', 'production']);
  for (const target of [release.test, release.production]) {
    exact(target, ['id', 'name', 'config']);
    if (!oid(target.id) || !oid(target.config?.server_id) ||
        target.config?.image?.type !== 'Image' || target.config.image.params?.image !== release.artifact) {
      throw new Error('release requires fixed resources and an immutable image');
    }
  }
  return { id: release.service, testTarget: release.test.name, productionTarget: release.production.name,
    artifact: release.artifact, configDigest: digest({ test: release.test, production: release.production }) };
}

export function createCatalog(input, initialManifest) {
  const manifest = validateManifest(initialManifest);
  if (!Array.isArray(input) || !input.length || input.length > 40) throw new Error('invalid release catalog');
  const releases = new Map();
  const resources = new Map();
  for (const item of structuredClone(input)) {
    const spec = releaseSpec(item);
    const initial = manifest.services.find(s => s.id === spec.id);
    if (!initial || initial.testTarget !== spec.testTarget || initial.productionTarget !== spec.productionTarget) throw new Error('catalog changes fixed targets');
    if (!/^sha256:[a-f0-9]{64}$/.test(spec.artifact)) throw new Error('immutable image required');
    for (const [role, target] of [['test', item.test], ['production', item.production]]) {
      const key = `${spec.id}/${role}`;
      if (resources.has(key) && resources.get(key) !== target.id) throw new Error('catalog changes resource IDs');
      if ([...resources].some(([other, id]) => other !== key && id === target.id)) throw new Error('resource reused across targets');
      resources.set(key, target.id);
    }
    if (releases.has(spec.configDigest)) throw new Error('duplicate release');
    releases.set(spec.configDigest, { spec, release: item });
  }
  function resolve(spec, operation) {
    const row = releases.get(spec.configDigest);
    if (!row || digest(row.spec) !== digest(spec)) throw new Error('release is absent from fixed catalog');
    const target = row.release[operation === 'test' ? 'test' : 'production'];
    return { service: spec.id, operation, target: target.id, name: target.name, artifact: spec.artifact,
      configDigest: spec.configDigest, targetConfigDigest: digest(target.config) };
  }
  for (const spec of manifest.services) resolve(spec, 'test');
  return Object.freeze({ manifest, resolve,
    binding: digest({ manifest, catalog: [...releases.values()].map(r => r.spec).sort((a, b) => a.configDigest.localeCompare(b.configDigest)) }) });
}

export function matchesResource(resource, plan) {
  return resource?._id?.$oid === plan.target && resource.name === plan.name &&
    digest(resource.config) === plan.targetConfigDigest && resource.config?.image?.params?.image === plan.artifact;
}
export function matchesUpdate(update, plan, id = update?._id?.$oid) {
  return oid(id) && update?._id?.$oid === id && update.operation === 'Deploy' &&
    update.target?.type === 'Deployment' && update.target.id === plan.target &&
    ['Queued', 'InProgress', 'Complete'].includes(update.status) && typeof update.success === 'boolean';
}
