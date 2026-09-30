import { KOMODO_VERSION } from '../komodo/mapping.mjs';
import { digest, exact } from '../execution/plan.mjs';

// Pure data boundary for a future read-only connector. No URL, credentials,
// transport, identity assertion or execution capability can enter this interface.
export function inspectFixtureInventory(catalog, releases, input) {
  exact(input, ['source', 'version', 'resources']);
  if (input.source !== 'synthetic-fixture' || input.version !== KOMODO_VERSION ||
      !Array.isArray(input.resources) || input.resources.length !== 8) throw new Error('unsupported preview inventory');
  const expected = new Map();
  for (const release of releases) for (const role of ['test', 'production']) {
    const target = release[role];
    if (!expected.has(target.id)) expected.set(target.id, { name: target.name, configs: new Set() });
    expected.get(target.id).configs.add(digest(target.config));
  }
  const seen = new Set();
  const resources = input.resources.map(resource => {
    exact(resource, ['id', 'name', 'config']);
    const target = expected.get(resource.id);
    if (!target || seen.has(resource.id) || target.name !== resource.name) throw new Error('preview inventory target mismatch');
    seen.add(resource.id);
    const configDigest = digest(resource.config);
    // Only known catalog image/configuration pairs are safe to display. Never
    // return a raw field from an unrecognized backend configuration or error body.
    const known = target.configs.has(configDigest);
    return { id: resource.id, name: target.name, known,
      artifact: known ? resource.config.image.params.image : null, configDigest: known ? configDigest : null };
  });
  return { source: 'synthetic-fixture', version: KOMODO_VERSION, catalogBinding: catalog.binding,
    connected: false, executionReady: false,
    gates: { authenticatedOwner: false, authenticatedTransport: false, exclusiveConfiguration: false }, resources };
}
