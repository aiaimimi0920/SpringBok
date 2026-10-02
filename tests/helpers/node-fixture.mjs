import { catalog, NAME, VOLUME } from '../../src/fixture-node/catalog.mjs';
const image = n => `sha256:${String(n).repeat(64)}`, id = n => n.toString(16).padStart(24, '0');
// Pinned 2.3.3 conversion.rs/labels.rs append a newline to nonempty strings.
// Source-derived response fixture, not a claim that a real Core ran here.
export function normalizedConfig(value) {
  const config = structuredClone(value);
  for (const key of ['ports', 'volumes', 'labels']) if (config[key] && !config[key].endsWith('\n')) config[key] += '\n';
  return config;
}
export function fixtureBackend() {
  const inventory = { version: 1, deployment: id(1), server: id(2), images: { v1: image(1), v2: image(2), bad: image(3) } }, c = catalog(inventory);
  let config = normalizedConfig(c.configs.v1), serial = 100, containerId;
  const updates = new Map();
  const api = { inventory, c, calls: [], hook: null,
    async call(path, params) {
      api.calls.push({ path, params: structuredClone(params) });
      if (api.hook) { const result = await api.hook(path, params); if (result !== undefined) return result; }
      if (path === 'read/GetVersion') return { version: '2.3.3' };
      if (path === 'read/GetServerState') return { status: 'Ok' };
      if (path === 'read/GetDeployment') return { _id: { $oid: id(1) }, name: NAME, config: structuredClone(config) };
      if (path === 'write/UpdateDeployment') { config = normalizedConfig(params.config); return {}; }
      if (path === 'execute/Deploy') { const update = { _id: { $oid: id(serial++) }, operation: 'Deploy', target: { type: 'Deployment', id: id(1) }, status: 'Complete', success: true }; containerId = serial.toString(16).padStart(64, '0'); updates.set(update._id.$oid, update); return update; }
      if (path === 'read/GetUpdate') return updates.get(params.id);
      if (path === 'read/InspectDeploymentContainer') {
        const version = Object.keys(inventory.images).find(v => inventory.images[v] === config.image.params.image), bad = version === 'bad';
        return { Id: containerId, Image: config.image.params.image, Mounts: [{ Type: 'volume', Name: VOLUME, Destination: '/data', RW: true }], State: { Status: bad ? 'exited' : 'running', Running: !bad, Paused: false, OOMKilled: false, ExitCode: bad ? 1 : 0, Health: { Status: 'healthy', Log: [{ ExitCode: 0, Output: JSON.stringify({ fixture: true, version, marker: 'a'.repeat(64) }) }] } } };
      }
      throw new Error('unexpected fixture API');
    } };
  return api;
}
