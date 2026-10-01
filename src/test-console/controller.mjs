import { join } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { openCoordinator } from '../execution/coordinator.mjs';
import { createCatalog, digest, exact, matchesResource, releaseSpec } from '../execution/plan.mjs';
import { project, dispatch, requestDigest, validateInput } from '../execution/projection.mjs';
import { openJournal } from '../execution/journal.mjs';
import { diagnostic, inspectExecution } from './diagnostics.mjs';

// Only the disposable integration harness constructs this controller. The fixed
// actor records a test click; it is not real owner authentication or AI exclusion.
const actor = { id: 'ci-ui-operator', role: 'human' };
export function openTestController({ directory, manifest, releases, versions, transport, timeoutMs = 5000 }) {
  const catalog = createCatalog(releases, manifest);
  const configs = new Map();
  for (const release of releases) for (const role of ['test', 'production']) {
    const target = release[role]; configs.set(`${target.id}/${digest(target.config)}`, structuredClone(target.config));
  }
  const labels = structuredClone(versions);
  exact(labels, ['v1', 'v2', 'bad']);
  for (const artifact of Object.values(labels)) if (!releases.some(r => r.artifact === artifact)) throw new Error('unknown test release');
  const confirmationKey = randomBytes(32); // Session-only plan binding, not authentication.
  const external = new Set(['test', 'promote', 'rollback']);
  let coordinator, staging, busy = false;
  function stages(events) {
    const rows = new Map();
    for (const [index, event] of events.entries()) {
      if (event.revision !== index + 1) throw new Error('invalid preparation sequence');
      if (event.kind === 'prepare') {
        exact(event, ['revision', 'kind', 'input', 'actor', 'plan']);
        validateInput(event.input, event.actor); exact(event.input.params, []);
        exact(event.plan, ['service', 'operation', 'target', 'name', 'artifact', 'configDigest', 'targetConfigDigest']);
        const release = releases.find(r => r.service === event.input.service && releaseSpec(r).configDigest === event.plan.configDigest);
        if (!release || digest(catalog.resolve(releaseSpec(release), event.input.operation)) !== digest(event.plan)) throw new Error('preparation plan mismatch');
        if (rows.has(event.input.id) || digest(event.actor) !== digest(actor) ||
            !['test', 'promote', 'rollback'].includes(event.input.operation) ||
            !configs.has(`${event.plan.target}/${event.plan.targetConfigDigest}`)) throw new Error('invalid preparation intent');
        rows.set(event.input.id, { ...event, status: 'unknown' });
      } else if (event.kind === 'prepared') {
        exact(event, ['revision', 'kind', 'requestId']);
        const row = rows.get(event.requestId);
        if (row?.status !== 'unknown') throw new Error('invalid preparation confirmation');
        row.status = 'prepared';
      } else throw new Error('invalid preparation event');
    }
    return rows;
  }
  try {
    staging = openJournal(join(directory, 'preparation'), catalog.binding, stages);
    coordinator = openCoordinator({ directory: join(directory, 'execution'), manifest, releases, transport, timeoutMs });
  } catch (error) { staging?.close(); throw error; }
  async function call(path, params) {
    const abort = new AbortController(); let timer;
    try {
      return await Promise.race([transport.call(path, structuredClone(params), { signal: abort.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('preparation timeout')); }, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  function snapshot() {
    const state = coordinator.snapshot();
    const prepared = [...stages(staging.read()).values()].map(r => ({ id: r.input.id, service: r.input.service, status: r.status }));
    return { ...state, mode: 'disposable-integration-test', revision: state.history.length + staging.read().length,
      versions: labels, preparation: prepared, preparationHistory: staging.read() };
  }
  async function exclusive(work) {
    if (busy) throw new Error('test controller busy'); busy = true;
    try { return await work(); } finally { busy = false; }
  }
  function planFor(body, state) {
    exact(body, ['revision', 'id', 'service', 'operation']);
    if (!Number.isSafeInteger(body.revision) || body.revision !== state.revision) {
      const error = new Error('stale test state'); error.status = 409; throw error;
    }
    if (!external.has(body.operation)) throw new Error('only execution actions have a review plan');
    if (state.preparation.some(r => r.service === body.service && r.status === 'unknown')) throw new Error('configuration preparation unknown');
    const input = { id: body.id, service: body.service, operation: body.operation, params: {} };
    return dispatch(project(catalog, state.history).lab, input, actor, catalog);
  }
  function signature(body, plan, expiresAt) {
    return createHmac('sha256', confirmationKey).update(digest({ body, plan, expiresAt })).digest('hex');
  }
  function verifyConfirmation(body, plan, confirmation) {
    exact(confirmation, ['expiresAt', 'signature']);
    if (!Number.isSafeInteger(confirmation.expiresAt) || confirmation.expiresAt <= Date.now() ||
        confirmation.expiresAt > Date.now() + 120000 || typeof confirmation.signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(confirmation.signature) ||
        !timingSafeEqual(Buffer.from(confirmation.signature), Buffer.from(signature(body, plan, confirmation.expiresAt)))) {
      const error = new Error('execution confirmation expired or changed'); error.status = 409; throw error;
    }
  }
  return {
    snapshot,
    preview(body) {
      if (busy) throw new Error('test controller busy');
      const plan = planFor(body, snapshot()), expiresAt = Date.now() + 120000;
      return { ...structuredClone(body), plan, confirmation: { expiresAt, signature: signature(body, plan, expiresAt) } };
    },
    action(body) {
      return exclusive(async () => {
        const state = snapshot();
        if (body.revision !== state.revision) { const e = new Error('stale test state'); e.status = 409; throw e; }
        const { revision: _revision, id, service, operation } = body;
        let params = {};
        if (operation === 'approve') {
          exact(body, ['revision', 'id', 'service', 'operation', 'binding', 'acknowledged']);
          if (body.acknowledged !== true) throw new Error('test acceptance acknowledgement required');
          params = { binding: body.binding };
        } else if (operation === 'candidate') {
          exact(body, ['revision', 'id', 'service', 'operation', 'version']);
          if (!Object.hasOwn(labels, body.version)) throw new Error('unknown fixed version');
          const release = releases.find(r => r.service === service && r.artifact === labels[body.version]);
          if (!release) throw new Error('unknown fixed release');
          params = { artifact: release.artifact, configDigest: releaseSpec(release).configDigest };
        } else {
          exact(body, ['revision', 'id', 'service', 'operation', 'confirmation']);
          const reviewBody = { revision: body.revision, id, service, operation };
          // Recompute under the same exclusive lock, before any durable or remote write.
          const plan = planFor(reviewBody, state);
          verifyConfirmation(reviewBody, plan, body.confirmation);
        }
        const input = { id, service, operation, params };
        if (state.requests.some(r => r.input.id === id)) return coordinator.submit(input, actor);
        const previous = stages(staging.read()).get(id);
        if (previous && requestDigest(previous.input, previous.actor) !== requestDigest(input, actor)) throw new Error('preparation ID reused');
        if ([...stages(staging.read()).values()].some(r => r.input.service === service && r.status === 'unknown')) throw new Error('configuration preparation unknown; no automatic retry');
        // Validate phase, exact approval binding and rollback target before any write.
        const detached = project(catalog, state.history);
        const plan = dispatch(detached.lab, input, actor, catalog);
        if (plan && !previous) {
          staging.append({ kind: 'prepare', input, actor, plan });
          try {
            await call('write/UpdateDeployment', { id: plan.target, config: configs.get(`${plan.target}/${plan.targetConfigDigest}`) });
            const resource = await call('read/GetDeployment', { deployment: plan.target });
            if (!matchesResource(resource, plan)) throw new Error('prepared configuration differs');
          } catch { return { status: 'preparation-unknown', input }; }
          staging.append({ kind: 'prepared', requestId: id });
        }
        return coordinator.submit(input, actor);
      });
    },
    inspect(body) {
      return exclusive(async () => {
        exact(body, ['revision', 'id']);
        const state = snapshot();
        if (body.revision !== state.revision) { const e = new Error('stale test state'); e.status = 409; throw e; }
        const request = state.requests.find(r => r.input.id === body.id && r.plan);
        const preparation = stages(staging.read()).get(body.id);
        if (!request && preparation?.status !== 'unknown') throw new Error('unknown execution record');
        const result = request ? await inspectExecution(request, call) : diagnostic('configuration-unknown');
        const record = request || preparation;
        return { revision: state.revision, requestId: body.id, service: record.input.service,
          operation: record.input.operation, target: record.plan.target, updateId: request?.updateId || null,
          observedAt: new Date().toISOString(), ...result };
      });
    },
    reconcile(id) { return exclusive(() => coordinator.reconcile(id)); },
    close() { if (busy) throw new Error('cannot close active controller'); coordinator.close(); staging.close(); },
  };
}
