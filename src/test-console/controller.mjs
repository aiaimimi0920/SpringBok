import { join } from 'node:path';
import { openCoordinator } from '../execution/coordinator.mjs';
import { createCatalog, digest, exact, matchesResource, releaseSpec } from '../execution/plan.mjs';
import { project, dispatch, requestDigest, validateInput } from '../execution/projection.mjs';
import { openJournal } from '../execution/journal.mjs';

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
  return {
    snapshot,
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
        } else exact(body, ['revision', 'id', 'service', 'operation']);
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
    reconcile(id) { return exclusive(() => coordinator.reconcile(id)); },
    close() { if (busy) throw new Error('cannot close active controller'); coordinator.close(); staging.close(); },
  };
}
