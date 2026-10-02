import { createHash } from 'node:crypto';
import { SERVICES } from '../contract.mjs';
import { KOMODO_VERSION } from '../komodo/mapping.mjs';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const roles = ['test', 'production'];
const namePattern = /^[a-z][a-z0-9-]{0,62}$/;
const fail = (field, rule) => { throw new Error(`${field}: ${rule}`); };
function exact(value, keys, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !== [...keys].sort().join()) fail(field, 'unexpected or missing fields');
}
function text(value, pattern, field, max = 128) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail(field, 'invalid identifier or format');
  return value;
}
function list(value, max, field) {
  if (!Array.isArray(value) || value.length > max) fail(field, 'invalid or oversized list');
  return value;
}
function port(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(field, 'port must be an integer from 1 to 65535');
  return value;
}
function image(value, field) {
  // Explicit registry + repository + digest; no tag, URL scheme, auth or shell syntax.
  text(value, /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/, field, 512);
  const registry = value.split('/')[0], [host, number] = registry.split(':');
  if (host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) fail(field, 'invalid registry hostname');
  if (number) port(Number(number), field);
  return value;
}
const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function compileConfiguration(input) {
  exact(input, ['version', 'project', 'services'], 'manifest');
  if (input.version !== 1) fail('version', 'expected 1');
  const project = text(input.project, namePattern, 'project');
  if (!list(input.services, 4, 'services').length) fail('services', 'at least one service required');
  const seen = new Set(), targetNames = new Set(), allocations = [], volumeOwners = new Map();
  const services = input.services.map((service, index) => {
    const field = `services[${index}]`; exact(service, ['id', 'image', 'test', 'production'], field);
    if (!SERVICES.includes(service.id) || seen.has(service.id)) fail(`${field}.id`, 'unknown or duplicate service');
    seen.add(service.id);
    const result = { id: service.id, image: image(service.image, `${field}.image`) };
    for (const role of roles) {
      const target = service[role], at = `${field}.${role}`;
      exact(target, ['serverId', 'deploymentName', 'ports', 'volumes', 'secretRefs'], at);
      const serverId = text(target.serverId, /^[a-f0-9]{24}$/, `${at}.serverId`);
      const deploymentName = text(target.deploymentName, namePattern, `${at}.deploymentName`);
      if (targetNames.has(deploymentName)) fail(`${at}.deploymentName`, 'target names must be unique across services and environments');
      targetNames.add(deploymentName);
      const ports = list(target.ports, 16, `${at}.ports`).map((p, i) => {
        const where = `${at}.ports[${i}]`; exact(p, ['hostIp', 'hostPort', 'containerPort', 'protocol'], where);
        if (!['127.0.0.1', '0.0.0.0'].includes(p.hostIp) || !['tcp', 'udp'].includes(p.protocol)) fail(where, 'unsupported bind address or protocol');
        port(p.hostPort, where); port(p.containerPort, where);
        if (allocations.some(old => old.serverId === serverId && old.hostPort === p.hostPort && old.protocol === p.protocol &&
          (old.hostIp === p.hostIp || old.hostIp === '0.0.0.0' || p.hostIp === '0.0.0.0'))) fail(where, 'host port overlaps another target');
        allocations.push({ serverId, ...p });
        return { hostIp: p.hostIp, hostPort: p.hostPort, containerPort: p.containerPort, protocol: p.protocol };
      }).sort((a, b) => compare(a.protocol, b.protocol) || a.hostPort - b.hostPort || a.containerPort - b.containerPort);
      const paths = new Set();
      const volumes = list(target.volumes, 8, `${at}.volumes`).map((v, i) => {
        const where = `${at}.volumes[${i}]`; exact(v, ['name', 'containerPath', 'readOnly'], where);
        text(v.name, namePattern, where);
        text(v.containerPath, /^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/, where, 128);
        if (v.containerPath.split('/').some(p => p === '.' || p === '..') ||
          /^\/(?:proc|sys|dev|run)(?:\/|$)|^\/var\/run(?:\/|$)/.test(v.containerPath) || typeof v.readOnly !== 'boolean') fail(where, 'unsupported mount path or mode');
        if ([...paths].some(p => p === v.containerPath || p.startsWith(v.containerPath + '/') || v.containerPath.startsWith(p + '/'))) fail(where, 'overlapping container mount paths');
        paths.add(v.containerPath);
        const key = `${serverId}/${v.name}`;
        if (volumeOwners.has(key)) fail(where, 'named volume reused across targets or mounts');
        volumeOwners.set(key, `${service.id}/${role}`);
        return { name: v.name, containerPath: v.containerPath, readOnly: v.readOnly };
      }).sort((a, b) => compare(a.containerPath, b.containerPath));
      const variables = new Set();
      const secretRefs = list(target.secretRefs, 16, `${at}.secretRefs`).map((ref, i) => {
        const where = `${at}.secretRefs[${i}]`; exact(ref, ['variable', 'reference'], where);
        text(ref.variable, /^[A-Z_][A-Z0-9_]{0,63}$/, where); text(ref.reference, namePattern, where);
        if (variables.has(ref.variable)) fail(where, 'duplicate secret variable'); variables.add(ref.variable);
        return { variable: ref.variable, reference: ref.reference };
      }).sort((a, b) => compare(a.variable, b.variable));
      result[role] = { serverId, deploymentName, ports, volumes, secretRefs };
    }
    return result;
  }).sort((a, b) => compare(a.id, b.id));
  const manifest = { version: 1, project, services };
  const drafts = services.flatMap(service => roles.map(role => {
    const target = service[role];
    const config = {
      server: target.serverId, swarm: '', image: { type: 'Image', params: { image: service.image } },
      network: 'bridge', restart: 'unless-stopped', command: '', extra_args: [],
      ports: target.ports.map(p => `${p.hostIp}:${p.hostPort}:${p.containerPort}/${p.protocol}`).join('\n'),
      volumes: target.volumes.map(v => `${v.name}:${v.containerPath}:${v.readOnly ? 'ro' : 'rw'}`).join('\n'),
      environment: '', skip_secret_interp: true, image_registry_account: '',
      auto_update: false, poll_for_updates: false, redeploy_on_build: false,
    };
    return { service: service.id, environment: role, name: target.deploymentName, config,
      configDigest: hash(config), unresolvedSecretRefs: target.secretRefs,
      requirements: ['resolve-complete-live-config-and-resource-ownership', 'verify-image-pull-platform-and-provenance',
        'verify-image-healthcheck-and-business-health', 'approve-runtime-and-authentication',
        ...(target.ports.some(p => p.hostIp === '0.0.0.0') ? ['review-external-network-exposure'] : []),
        ...(target.volumes.length ? ['verify-volume-provisioning-ownership-backups-and-data-migration'] : []),
        ...(target.secretRefs.length ? ['resolve-secret-references-through-approved-channel'] : [])] };
  }));
  return { mode: 'user-configuration-review', configurationKind: 'partial-deployment-drafts-not-import-or-execution', komodoVersion: KOMODO_VERSION, executable: false, readiness: false,
    manifestDigest: hash(manifest), manifest, omittedServices: SERVICES.filter(id => !seen.has(id)), drafts };
}
