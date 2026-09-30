import { SERVICES } from '../contract.mjs';
import { createCatalog, digest } from '../execution/plan.mjs';
import { project, dispatch } from '../execution/projection.mjs';
import { inspectFixtureInventory } from './connection.mjs';

export const PREVIEW_OPERATIONS = Object.freeze(['test', 'promote', 'rollback']);
export function previewPlan({ manifest, releases, events, inventory, service, operation }) {
  if (!SERVICES.includes(service) || !PREVIEW_OPERATIONS.includes(operation)) throw new Error('unknown preview selection');
  const catalog = createCatalog(releases, manifest);
  const connection = inspectFixtureInventory(catalog, releases, inventory);
  const state = project(catalog, events);
  const record = state.lab.snapshot().services.find(r => r.spec.id === service);
  const binding = state.lab.approvalBinding(service);
  let plan = operation === 'rollback' ? null : catalog.resolve(record.spec, operation);
  let contractEligible = false;
  try {
    // The projection is private to this preview. Its in-memory transition is
    // discarded; neither an approval nor an execution intent is persisted.
    plan = dispatch(state.lab, { id: 'preview-only', service, operation, params: {} },
      { id: 'preview-inspector', role: 'ai' }, catalog);
    contractEligible = true;
  } catch { /* Return a bounded reason, never arbitrary backend/configuration text. */ }
  const requests = [...state.requests.values()];
  const unresolved = requests.some(r => r.input.service === service && ['unknown', 'accepted'].includes(r.status));
  let rollbackAvailable = false;
  try {
    dispatch(project(catalog, events).lab, { id: 'preview-rollback', service, operation: 'rollback', params: {} },
      { id: 'preview-inspector', role: 'ai' }, catalog);
    rollbackAvailable = !unresolved;
  } catch { /* The same contract owns rollback eligibility for every preview. */ }
  const latest = plan ? requests.filter(r => r.plan?.target === plan.target).at(-1) : null;
  const knownState = latest?.status === 'succeeded' ? latest.plan : null;
  const observed = plan ? connection.resources.find(r => r.id === plan.target) : null;
  const targetConfirmed = !unresolved && !!knownState && observed?.known === true &&
    observed.artifact === knownState.artifact && observed.configDigest === knownState.targetConfigDigest;
  const reason = unresolved ? 'unresolved-execution' : !contractEligible ?
    (operation === 'promote' && record.phase === 'tested' ? 'approval-required' :
      operation === 'rollback' && !record.active ? 'no-known-good-release' : 'phase-blocked') :
    observed?.known !== true ? 'inventory-unknown' :
      observed.configDigest !== plan.targetConfigDigest ? 'configuration-preparation-required' :
        !targetConfirmed ? 'state-unconfirmed' : 'fixture-contract-only';
  return {
    mode: 'offline-plan-preview', service, operation, phase: record.phase,
    contractEligible, executable: false, reason, catalogBinding: catalog.binding, approvalBinding: binding,
    plan, connection: { source: connection.source, version: connection.version, connected: false,
      executionReady: false, gates: connection.gates },
    current: { status: targetConfirmed ? 'fixture-record-and-inventory-match' : 'unknown',
      artifact: targetConfirmed ? knownState.artifact : null,
      configDigest: targetConfirmed ? knownState.targetConfigDigest : null },
    changes: plan ? ['artifact', 'targetConfigDigest'].map(field => ({
      field, from: targetConfirmed ? knownState[field] : null, to: plan[field],
      changed: targetConfirmed ? knownState[field] !== plan[field] : null,
    })) : [],
    rollbackAvailable,
    history: { eventCount: events.length, digest: digest(events) },
  };
}
