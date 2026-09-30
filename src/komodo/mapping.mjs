import { createHash } from 'node:crypto';
import { SERVICES } from '../contract.mjs';
export const KOMODO_VERSION = '2.3.3';
export const hash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function deploymentRequest(service, environment, image, server = 'springbok-ci') {
  if (!SERVICES.includes(service) || !['test', 'production'].includes(environment)) throw new Error('unknown target');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('immutable local image ID required');
  // Deliberately limited to the disposable integration server, not a generic executor.
  if (server !== 'springbok-ci') throw new Error('only disposable integration server is supported');
  return {
    name: `springbok-${service}-${environment}`,
    config: {
      server_id: server, image: { type: 'Image', params: { image } },
      network: 'none', restart: 'no', command: '', ports: '', volumes: '',
      environment: `SERVICE=${service}`, labels: 'springbok.integration=true',
      extra_args: ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m', '--cpus=1'],
      skip_secret_interp: true, auto_update: false, poll_for_updates: false, redeploy_on_build: false,
    },
  };
}
export function releaseManifest(image) {
  return { version: 1, services: SERVICES.map(id => {
    const test = deploymentRequest(id, 'test', image);
    const production = deploymentRequest(id, 'production', image);
    return { id, testTarget: test.name, productionTarget: production.name, artifact: image,
      configDigest: hash({ test: test.config, production: production.config }) };
  }) };
}
export function testProcedureRequest(service) {
  if (!SERVICES.includes(service)) throw new Error('unknown service');
  return { name: `springbok-${service}-test-only`, config: {
    stages: [{ name: 'Deploy fixed test target', enabled: true,
      executions: [{ enabled: true, execution: { type: 'Deploy', params: { deployment: `springbok-${service}-test` } } }] }],
    schedule: '', schedule_enabled: false, webhook_enabled: false,
  } };
}
