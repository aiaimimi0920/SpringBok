import { exact, submission } from '../../cloud/protocol.mjs';
import { fixtureEvidence, STAGES } from '../../cloud/fixture-contract.mjs';
import { openJournal } from '../execution/journal.mjs';
import { matchesResource, matchesUpdate, digest } from '../execution/plan.mjs';
import { containerMatches } from '../komodo/ci-client.mjs';
import { catalog, VOLUME } from './catalog.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function containerEvidence(container, plan, stage) {
  if (typeof container?.Id !== 'string' || !/^[a-f0-9]{64}$/.test(container.Id) || !containerMatches(container, plan.artifact, stage !== 'bad')) throw new Error('fixture health unconfirmed');
  if (!Array.isArray(container.Mounts) || container.Mounts.length !== 1 || container.Mounts[0].Type !== 'volume' || container.Mounts[0].Name !== VOLUME || container.Mounts[0].Destination !== '/data' || container.Mounts[0].RW !== true) throw new Error('fixture volume mismatch');
  if (stage === 'bad') return { health: 'expected-exit-1', marker: null, containerId: container.Id };
  const log = container.State.Health.Log?.at(-1);
  if (log?.ExitCode !== 0 || typeof log.Output !== 'string' || log.Output.length > 256) throw new Error('fixture receipt absent');
  const value = JSON.parse(log.Output); exact(value, ['fixture', 'version', 'marker']);
  if (value.fixture !== true || value.version !== (stage === 'rollback-v1' ? 'v1' : stage) || typeof value.marker !== 'string' || !/^[a-f0-9]{64}$/.test(value.marker)) throw new Error('fixture receipt mismatch');
  return { health: 'healthy', marker: value.marker, containerId: container.Id };
}
// One explicitly armed fixture cycle per dedicated journal. Never a human approval
// or general deployment API. The transport can only be provided by trusted code.
export function openFixtureExecutor({ directory, inventory, transport, stageTimeoutMs = 60000, pollMs = 1000, storage = {} }) {
  const c = catalog(inventory);
  if (typeof transport?.call !== 'function' || !Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs < 1 || stageTimeoutMs > 60000 || !Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > 1000) throw new Error('invalid fixture executor');
  function project(events) {
    let input, pending = null, evidence = null; const rows = [];
    for (const [i, event] of events.entries()) {
      if (event.revision !== i + 1) throw new Error('invalid fixture sequence');
      if (event.kind === 'started') {
        exact(event, ['kind', 'input', 'revision']); if (input || i) throw new Error('duplicate cycle');
        input = submission(event.input); if (input.operation !== 'fixture-cycle' || input.challenge !== c.binding) throw new Error('fixture binding mismatch');
      } else if (event.kind === 'intent') {
        exact(event, ['kind', 'stage', 'revision']);
        if (!input || pending || evidence || event.stage !== STAGES[rows.length]) throw new Error('invalid stage order'); pending = event.stage;
      } else if (event.kind === 'stage') {
        exact(event, ['kind', 'row', 'revision']);
        const row = event.row, version = pending === 'rollback-v1' ? 'v1' : pending, plan = c.plans[version];
        exact(row, ['stage', 'target', 'updateId', 'image', 'configDigest', 'health', 'marker', 'containerId']);
        if (!plan || row.stage !== pending || row.target !== plan.target || row.image !== plan.artifact || row.configDigest !== plan.targetConfigDigest || typeof row.updateId !== 'string' || !/^[a-f0-9]{24}$/.test(row.updateId) || rows.some(r => r.updateId === row.updateId) || typeof row.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(row.containerId) || rows.some(r => r.containerId === row.containerId)) throw new Error('invalid stage evidence');
        if (pending === 'bad' ? row.health !== 'expected-exit-1' || row.marker !== null : row.health !== 'healthy' || typeof row.marker !== 'string' || !/^[a-f0-9]{64}$/.test(row.marker) || (rows.length > 0 && row.marker !== rows[0].marker)) throw new Error('invalid stage health');
        rows.push(row); pending = null;
      } else if (event.kind === 'complete') {
        exact(event, ['kind', 'evidence', 'revision']);
        if (!input || pending || evidence || rows.length !== 4 || digest(event.evidence.stages) !== digest(rows)) throw new Error('invalid cycle completion');
        evidence = fixtureEvidence(event.evidence, c.binding);
      } else throw new Error('invalid fixture event');
    }
    return { input, rows, evidence };
  }
  const journal = openJournal(directory, c.binding, project, storage); let busy = false;
  async function call(path, params) {
    const controller = new AbortController(); let timer;
    try { return await Promise.race([Promise.resolve().then(() => transport.call(path, structuredClone(params), { signal: controller.signal })), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('fixture request timeout')); }, 5000); })]); }
    catch { throw new Error('fixture transport unavailable'); } finally { clearTimeout(timer); }
  }
  return Object.freeze({ binding: c.binding, snapshot: () => journal.read(), close() { if (busy) throw new Error('fixture busy'); journal.close(); },
    async run(value) {
      if (busy) throw new Error('fixture busy'); busy = true;
      try {
        const input = submission(structuredClone(value));
        if (input.operation !== 'fixture-cycle' || input.challenge !== c.binding) throw new Error('fixture binding mismatch');
        const old = project(journal.read());
        if (old.input) {
          if (digest(old.input) !== digest(input)) throw new Error('fixture already used');
          return old.evidence ? { outcome: 'fixture-verified', evidence: old.evidence } : { outcome: 'unknown' };
        }
        // Read-only checks precede the durable one-cycle boundary.
        if ((await call('read/GetVersion', {})).version !== '2.3.3' || (await call('read/GetServerState', { server: c.input.server })).status !== 'Ok' || !matchesResource(await call('read/GetDeployment', { deployment: c.input.deployment }), c.plans.v1)) throw new Error('fixture preflight mismatch');
        journal.append({ kind: 'started', input });
        try {
          let previous = 'v1'; const rows = [];
          for (const stage of STAGES) {
            const version = stage === 'rollback-v1' ? 'v1' : stage, plan = c.plans[version];
            if (!matchesResource(await call('read/GetDeployment', { deployment: plan.target }), c.plans[previous])) throw new Error('fixture configuration drift');
            journal.append({ kind: 'intent', stage });
            await call('write/UpdateDeployment', { id: plan.target, config: c.configs[version] });
            if (!matchesResource(await call('read/GetDeployment', { deployment: plan.target }), plan)) throw new Error('fixture write unconfirmed');
            const update = await call('execute/Deploy', { deployment: plan.target });
            if (!matchesUpdate(update, plan)) throw new Error('fixture update mismatch');
            const until = Date.now() + stageTimeoutMs; let row;
            do {
              const current = await call('read/GetUpdate', { id: update._id.$oid });
              if (!matchesUpdate(current, plan, update._id.$oid)) throw new Error('fixture result mismatch');
              if (current.status === 'Complete') {
                if (!current.success) throw new Error('fixture deploy failed');
                if (!matchesResource(await call('read/GetDeployment', { deployment: plan.target }), plan)) throw new Error('fixture configuration drift');
                const container = await call('read/InspectDeploymentContainer', { deployment: plan.target });
                try {
                  row = { stage, target: plan.target, updateId: update._id.$oid, image: plan.artifact, configDigest: plan.targetConfigDigest, ...containerEvidence(container, plan, stage) };
                } catch { /* Health may still be starting; never accept partial evidence. */ }
                if (row) break;
              }
              if (Date.now() < until) await delay(pollMs);
            } while (Date.now() < until);
            if (!row || (stage !== 'bad' && rows.length && row.marker !== rows[0].marker)) throw new Error('fixture evidence unconfirmed');
            journal.append({ kind: 'stage', row }); rows.push(row); previous = version;
          }
          const evidence = fixtureEvidence({ binding: c.binding, volume: VOLUME, stages: rows }, c.binding);
          journal.append({ kind: 'complete', evidence }); return { outcome: 'fixture-verified', evidence };
        } catch { return { outcome: 'unknown' }; }
      } finally { busy = false; }
    },
  });
}
