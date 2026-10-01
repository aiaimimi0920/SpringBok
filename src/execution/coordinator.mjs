import { createCatalog, matchesResource, matchesUpdate } from './plan.mjs';
import { project, dispatch, requestDigest, validateInput, resultEvidence } from './projection.mjs';
import { openJournal } from './journal.mjs';
import { containerMatches } from '../komodo/ci-client.mjs';

// Library boundary only. Identity and transport are trusted harness inputs, NOT
// authenticated users or an enabled production connection. No default transport.
export function openCoordinator({ directory, manifest, releases, transport, timeoutMs = 5000, storage = {} }) {
  if (typeof transport?.call !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error('invalid execution transport options');
  const catalog = createCatalog(releases, manifest);
  const journal = openJournal(directory, catalog.binding, events => project(catalog, events), storage);
  let busy = false;
  const projection = () => project(catalog, journal.read());
  try {
    const invalidated = [...projection().approvals.values()].sort();
    if (invalidated.length) journal.append({ kind: 'restart', invalidated });
  } catch (error) { journal.close(); throw error; }
  async function call(path, params) {
    const abort = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => transport.call(path, structuredClone(params), { signal: abort.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('execution request timed out')); }, timeoutMs); }),
      ]);
    } catch { throw new Error('execution transport unavailable or timed out'); }
    finally { clearTimeout(timer); }
  }
  async function exclusive(work) {
    if (busy) throw new Error('execution coordinator busy');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  function snapshot() {
    const state = projection();
    return structuredClone({ mode: 'execution-recovery-lab', services: state.lab.snapshot().services,
      requests: [...state.requests.values()], bindings: Object.fromEntries(catalog.manifest.services.map(s => [s.id, state.lab.approvalBinding(s.id)])),
      history: journal.read() });
  }
  const current = id => snapshot().requests.find(r => r.input.id === id);
  return Object.freeze({
    snapshot,
    submit(input, actor) {
      return exclusive(async () => {
        // Detach caller-owned objects before any async suspension.
        input = structuredClone(input); actor = structuredClone(actor); validateInput(input, actor);
        const state = projection(), existing = state.requests.get(input.id);
        if (existing) {
          if (requestDigest(existing.input, existing.actor) !== requestDigest(input, actor)) throw new Error('request ID reused with different intent');
          return current(input.id);
        }
        const plan = dispatch(state.lab, input, actor, catalog);
        if (!plan) { journal.append({ kind: 'action', input, actor }); return current(input.id); }
        const resource = await call('read/GetDeployment', { deployment: plan.target });
        if (!matchesResource(resource, plan)) throw new Error('deployment configuration drift');
        // Persist the transition and consumed approval BEFORE any execute request.
        // From here, even a crash before send is conservatively UNKNOWN.
        journal.append({ kind: 'intent', input, actor, plan });
        let update;
        try { update = await call('execute/Deploy', { deployment: plan.target }); }
        catch { return current(input.id); }
        if (!matchesUpdate(update, plan)) return current(input.id);
        journal.append({ kind: 'accepted', requestId: input.id, updateId: update._id.$oid });
        return current(input.id);
      });
    },
    reconcile(requestId) {
      return exclusive(async () => {
        const request = projection().requests.get(requestId);
        if (!request) throw new Error('unknown execution request');
        if (request.status === 'unknown') throw new Error('submission unknown; automatic resubmission is forbidden');
        if (request.status !== 'accepted') return current(requestId);
        const update = await call('read/GetUpdate', { id: request.updateId });
        if (!matchesUpdate(update, request.plan, request.updateId)) throw new Error('execution result mismatch');
        if (update.status !== 'Complete') return current(requestId);
        let resource, container;
        if (update.success) {
          resource = await call('read/GetDeployment', { deployment: request.plan.target });
          container = await call('read/InspectDeploymentContainer', { deployment: request.plan.target });
          if (!matchesResource(resource, request.plan)) throw new Error('execution configuration not confirmed');
          if (containerMatches(container, request.plan.artifact, false)) {
            // Deploy may complete successfully while the exact fixture exits 1.
            // Preserve that distinction instead of inventing Update.success=false.
            journal.append({ kind: 'health-failure', requestId, evidence: {
              updateId: request.updateId, target: request.plan.target, updateSuccess: true,
              configDigest: request.plan.targetConfigDigest, image: container.Image,
              status: 'exited', exitCode: 1, paused: false, oomKilled: false,
            } });
            return current(requestId);
          }
          if (!containerMatches(container, request.plan.artifact)) throw new Error('execution health or configuration not confirmed');
        }
        journal.append({ kind: 'outcome', requestId, evidence: resultEvidence(update, request, resource, container) });
        return current(requestId);
      });
    },
    close() { if (busy) throw new Error('cannot close an active execution call'); journal.close(); },
  });
}
