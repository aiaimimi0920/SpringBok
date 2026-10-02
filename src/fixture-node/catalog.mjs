import { exact } from '../../cloud/protocol.mjs';
import { digest, oid } from '../execution/plan.mjs';
export const NAME = 'springbok-node-fixture';
export const VOLUME = 'springbok-fixture-data';
// Complete Komodo 2.3.3 DeploymentConfig, from the pinned upstream schema.
// Nonempty conversions/labels serialize with a trailing newline in 2.3.3.
// No caller-controlled command, path, flags, registry account, or environment.
export function configuration(server, image) {
  if (!oid(server) || typeof image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('invalid fixture inventory');
  return { swarm_id: '', server_id: server, custom_name: '', image: { type: 'Image', params: { image } },
    image_registry_account: '', skip_secret_interp: true, redeploy_on_build: false, poll_for_updates: false,
    auto_update: false, send_alerts: false, links: [], network: 'none', restart: 'no', command: '', replicas: 1,
    termination_signal: 'SIGTERM', termination_timeout: 10,
    extra_args: ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m', '--cpus=0.5'],
    term_signal_labels: '', ports: '', volumes: `${VOLUME}:/data\n`, environment: '', labels: 'springbok.fixture-node=true\n' };
}
export function catalog(value) {
  exact(value, ['version', 'deployment', 'server', 'images']); exact(value.images, ['v1', 'v2', 'bad']);
  if (value.version !== 1 || !oid(value.deployment) || !oid(value.server) || new Set(Object.values(value.images)).size !== 3) throw new Error('invalid fixture inventory');
  const configs = Object.fromEntries(Object.entries(value.images).map(([version, image]) => [version, configuration(value.server, image)]));
  const binding = digest({ version: 1, deployment: value.deployment, name: NAME, configs }).slice(7);
  const plans = Object.fromEntries(Object.entries(configs).map(([version, config]) => [version, {
    target: value.deployment, name: NAME, artifact: value.images[version], targetConfigDigest: digest(config), operation: 'test',
  }]));
  return { input: structuredClone(value), configs, plans, binding };
}

// Explicit, local one-time assembly helper. Never reachable from the cloud job.
// A lost CreateDeployment response is NOT retried; preserve Core and inspect it.
export async function prepareInventory(images, transport) {
  exact(images, ['v1', 'v2', 'bad']);
  if (new Set(Object.values(images)).size !== 3) throw new Error('distinct fixture images required');
  for (const image of Object.values(images)) configuration('0'.repeat(24), image);
  const server = await transport.call('read/GetServer', { server: 'springbok-node-test' });
  if (!oid(server?._id?.$oid) || server.name !== 'springbok-node-test' || (await transport.call('read/GetServerState', { server: server._id.$oid })).status !== 'Ok') throw new Error('fixture server unavailable');
  const config = configuration(server._id.$oid, images.v1);
  const resource = await transport.call('write/CreateDeployment', { name: NAME, config });
  if (!oid(resource?._id?.$oid) || resource.name !== NAME || digest(resource.config) !== digest(config)) throw new Error('fixture creation uncertain; do not retry');
  const value = { version: 1, deployment: resource._id.$oid, server: server._id.$oid, images: structuredClone(images) };
  catalog(value); return value;
}
