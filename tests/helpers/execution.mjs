import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICES } from '../../src/contract.mjs';
import { releaseSpec } from '../../src/execution/plan.mjs';
import { openCoordinator } from '../../src/execution/coordinator.mjs';

export const image = n => `sha256:${String(n).repeat(64)}`;
export const objectId = n => n.toString(16).padStart(24, '0');
export const human = { id: 'fixture-owner', role: 'human' };
export const ai = { id: 'fixture-assistant', role: 'ai' };
export const input = (id, operation, params = {}, service = 'gateway') => ({ id, service, operation, params });
export function catalog() {
  const releases = [1, 2].flatMap(version => SERVICES.map((service, i) => {
    const target = role => ({ id: objectId(i * 2 + (role === 'test' ? 1 : 2)), name: `${service}-${role}`,
      config: { server_id: objectId(100), image: { type: 'Image', params: { image: image(version) } },
        command: '', ports: '', volumes: '', network: 'none', auto_update: false } });
    return { service, artifact: image(version), test: target('test'), production: target('production') };
  }));
  return { releases, manifest: { version: 1, services: releases.slice(0, 4).map(releaseSpec) } };
}
export function fakeBackend(releases) {
  const resources = new Map(), updates = new Map(), calls = [];
  let next = 500;
  const api = {
    calls, resources, updates, executeCount: 0, hook: null,
    stage(release) { for (const target of [release.test, release.production]) resources.set(target.id, { _id: { $oid: target.id }, name: target.name, config: structuredClone(target.config) }); },
    async call(path, params, options = {}) {
      calls.push({ path, params: structuredClone(params) });
      if (api.hook) { const override = await api.hook(path, params, options); if (override !== undefined) return override; }
      if (path === 'read/GetDeployment') return structuredClone(resources.get(params.deployment));
      if (path === 'execute/Deploy') {
        api.executeCount++;
        const update = { _id: { $oid: objectId(next++) }, operation: 'Deploy', target: { type: 'Deployment', id: params.deployment }, status: 'Queued', success: false };
        updates.set(update._id.$oid, { ...update, status: 'Complete', success: true }); return structuredClone(update);
      }
      if (path === 'read/GetUpdate') return structuredClone(updates.get(params.id));
      if (path === 'read/InspectDeploymentContainer') return { Image: resources.get(params.deployment).config.image.params.image,
        State: { Status: 'running', Running: true, Paused: false, OOMKilled: false, Health: { Status: 'healthy' } } };
      throw new Error('unexpected fake operation');
    },
  };
  releases.slice(0, 4).forEach(api.stage); return api;
}
export function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-execution-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = catalog(), backend = fakeBackend(data.releases);
  const options = { directory, ...data, transport: backend, ...extra };
  let coordinator = openCoordinator(options);
  t.after(() => coordinator.close());
  return { directory, data, backend, get coordinator() { return coordinator; },
    restart(changes = {}) { coordinator.close(); coordinator = openCoordinator({ ...options, ...changes }); return coordinator; } };
}
export const row = (c, service = 'gateway') => c.snapshot().services.find(r => r.spec.id === service);
export async function deploy(c, id, operation, service = 'gateway') {
  await c.submit(input(id, operation, {}, service), ai); return c.reconcile(id);
}
export async function approve(c, id, service = 'gateway') {
  return c.submit(input(id, 'approve', { binding: c.snapshot().bindings[service] }, service), human);
}
