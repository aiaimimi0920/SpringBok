import { SERVICES } from '../contract.mjs';
import { deploymentRequest, KOMODO_VERSION } from '../komodo/mapping.mjs';
import { createCatalog, releaseSpec } from '../execution/plan.mjs';
import { project, dispatch } from '../execution/projection.mjs';
import { previewPlan, PREVIEW_OPERATIONS } from './plan.mjs';

export const SCENARIOS = Object.freeze(['fresh', 'approved', 'live', 'unknown']);
const id = n => n.toString(16).padStart(24, '0');
const image = version => `sha256:${String(version).repeat(64)}`;
const human = { id: 'synthetic-owner', role: 'human' };
const ai = { id: 'synthetic-assistant', role: 'ai' };
export function previewFixture(service, scenario) {
  if (!SERVICES.includes(service) || !SCENARIOS.includes(scenario)) throw new Error('unknown preview fixture');
  const releases = [1, 2].flatMap(version => SERVICES.map((service, i) => {
    const target = role => {
      const request = deploymentRequest(service, role, image(version));
      return { id: id(i * 2 + (role === 'test' ? 1 : 2)), name: request.name,
        config: { ...request.config, server_id: id(100) } };
    };
    return { service, artifact: image(version), test: target('test'), production: target('production') };
  }));
  const manifest = { version: 1, services: releases.slice(0, 4).map(releaseSpec) };
  const catalog = createCatalog(releases, manifest), events = [];
  const resources = new Map();
  for (const release of releases.slice(0, 4)) for (const target of [release.test, release.production]) resources.set(target.id, structuredClone(target));
  const append = event => { events.push({ ...event, revision: events.length + 1 }); project(catalog, events); };
  function operation(operation, params = {}, actor = ai, unknown = false) {
    const state = project(catalog, events), input = { id: `fixture-${events.length + 1}`, service, operation, params };
    const plan = dispatch(state.lab, input, actor, catalog);
    if (!plan) return append({ kind: 'action', input, actor });
    append({ kind: 'intent', input, actor, plan });
    if (unknown) return;
    const updateId = id(1000 + events.length);
    append({ kind: 'accepted', requestId: input.id, updateId });
    append({ kind: 'outcome', requestId: input.id, evidence: { updateId, target: plan.target,
      success: true, configDigest: plan.targetConfigDigest, image: plan.artifact, healthy: true } });
  }
  const approve = () => operation('approve', { binding: project(catalog, events).lab.approvalBinding(service) }, human);
  if (scenario !== 'fresh') {
    operation('test'); approve(); operation('promote');
    const next = releases.find(r => r.service === service && r.artifact === image(2));
    const spec = releaseSpec(next);
    operation('candidate', { artifact: spec.artifact, configDigest: spec.configDigest }, human);
    resources.set(next.test.id, structuredClone(next.test));
    operation('test'); approve();
    if (scenario === 'live' || scenario === 'unknown') {
      resources.set(next.production.id, structuredClone(next.production));
      operation('promote', {}, ai, scenario === 'unknown');
    }
  }
  return { releases, manifest, events, inventory: { source: 'synthetic-fixture', version: KOMODO_VERSION,
    resources: [...resources.values()] } };
}
export function fixturePreview(service, scenario, operation) {
  if (!PREVIEW_OPERATIONS.includes(operation)) throw new Error('unknown preview operation');
  return { ...previewPlan({ ...previewFixture(service, scenario), service, operation }), scenario };
}
