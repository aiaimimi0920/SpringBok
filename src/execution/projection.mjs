import { createLab } from '../contract.mjs';
import { digest, exact, matchesUpdate, oid } from './plan.mjs';

const external = new Set(['test', 'promote', 'rollback']);
const local = new Set(['approve', 'candidate']);
const runner = { id: 'execution-evidence', role: 'runner' };
export const requestDigest = (input, actor) => digest({ input, actor });
export function validateInput(input, actor) {
  exact(input, ['id', 'service', 'operation', 'params']);
  exact(actor, ['id', 'role']);
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.id) ||
      !['human', 'ai'].includes(actor.role) || !external.has(input.operation) && !local.has(input.operation)) {
    throw new Error('unsupported execution request');
  }
}
export function dispatch(lab, input, actor, catalog) {
  validateInput(input, actor);
  const record = lab.dispatch({ service: input.service, operation: input.operation, params: input.params }, actor);
  const spec = input.operation === 'rollback' ? record.pendingRollback : record.spec;
  const plan = catalog.resolve(spec, input.operation);
  return external.has(input.operation) ? plan : null;
}
export function project(catalog, events) {
  if (!Array.isArray(events) || events.length > 1000) throw new Error('invalid execution history');
  const skipped = new Set();
  const fresh = () => ({ lab: createLab(catalog.manifest), requests: new Map(), approvals: new Map() });
  let state = fresh();
  function apply(event) {
    if (['action', 'intent'].includes(event.kind)) {
      exact(event, event.kind === 'intent' ? ['revision', 'kind', 'input', 'actor', 'plan'] : ['revision', 'kind', 'input', 'actor']);
      const { input, actor } = event;
      validateInput(input, actor);
      if (state.requests.has(input.id)) throw new Error('duplicate execution request ID');
      if ((event.kind === 'intent') !== external.has(input.operation)) throw new Error('invalid request event');
      if (skipped.has(input.id)) {
        if (input.operation !== 'approve') throw new Error('only approval may be revoked');
        state.requests.set(input.id, { input, actor, status: 'revoked' }); return;
      }
      const plan = dispatch(state.lab, input, actor, catalog);
      if (event.kind === 'intent' && digest(plan) !== digest(event.plan)) throw new Error('execution plan mismatch');
      state.requests.set(input.id, { input, actor, status: plan ? 'unknown' : 'completed', ...(plan ? { plan } : {}) });
      if (input.operation === 'approve') state.approvals.set(input.service, input.id);
      else state.approvals.delete(input.service);
    } else if (event.kind === 'accepted') {
      exact(event, ['revision', 'kind', 'requestId', 'updateId']);
      const request = state.requests.get(event.requestId);
      if (request?.status !== 'unknown' || !oid(event.updateId) ||
          [...state.requests.values()].some(r => r.updateId === event.updateId)) throw new Error('invalid execution ID receipt');
      request.updateId = event.updateId; request.status = 'accepted';
    } else if (event.kind === 'outcome') {
      exact(event, ['revision', 'kind', 'requestId', 'evidence']);
      const request = state.requests.get(event.requestId), e = event.evidence;
      exact(e, ['updateId', 'target', 'success', 'configDigest', 'image', 'healthy']);
      if (request?.status !== 'accepted' || e.updateId !== request.updateId || e.target !== request.plan.target || typeof e.success !== 'boolean') throw new Error('invalid result binding');
      if (e.success ? e.configDigest !== request.plan.targetConfigDigest || e.image !== request.plan.artifact || e.healthy !== true :
        e.configDigest !== null || e.image !== null || e.healthy !== null) throw new Error('invalid result evidence');
      const operation = { test: 'test-result', promote: 'production-result', rollback: 'rollback-result' }[request.input.operation];
      state.lab.dispatch({ service: request.input.service, operation, params: { success: e.success } }, runner);
      request.status = e.success ? 'succeeded' : 'failed';
    } else if (event.kind === 'health-failure') {
      exact(event, ['revision', 'kind', 'requestId', 'evidence']);
      const request = state.requests.get(event.requestId), e = event.evidence;
      exact(e, ['updateId', 'target', 'updateSuccess', 'configDigest', 'image', 'status', 'exitCode', 'paused', 'oomKilled']);
      if (request?.status !== 'accepted' || e.updateId !== request.updateId || e.target !== request.plan.target ||
          e.updateSuccess !== true || e.configDigest !== request.plan.targetConfigDigest || e.image !== request.plan.artifact ||
          e.status !== 'exited' || e.exitCode !== 1 || e.paused !== false || e.oomKilled !== false) throw new Error('invalid failed-container evidence');
      const operation = { test: 'test-result', promote: 'production-result', rollback: 'rollback-result' }[request.input.operation];
      state.lab.dispatch({ service: request.input.service, operation, params: { success: false } }, runner);
      request.status = 'failed'; request.failure = 'container-exited-1';
    } else throw new Error('unknown execution event');
  }
  events.forEach((event, index) => {
    if (event.revision !== index + 1) throw new Error('invalid execution sequence');
    if (event.kind === 'restart') {
      exact(event, ['revision', 'kind', 'invalidated']);
      const expected = [...state.approvals.values()].sort();
      if (!expected.length || JSON.stringify(event.invalidated) !== JSON.stringify(expected)) throw new Error('invalid approval restart');
      expected.forEach(id => skipped.add(id)); state = fresh();
      for (let j = 0; j < index; j++) if (events[j].kind !== 'restart') apply(events[j]);
    } else apply(event);
  });
  return state;
}

export function resultEvidence(update, request, resource, container) {
  if (!matchesUpdate(update, request.plan, request.updateId) || update.status !== 'Complete') throw new Error('execution result is not final and bound');
  return { updateId: request.updateId, target: request.plan.target, success: update.success,
    configDigest: update.success ? digest(resource.config) : null,
    image: update.success ? container.Image : null, healthy: update.success ? true : null };
}
