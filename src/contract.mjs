import { createHash } from 'node:crypto';

export const SERVICES = Object.freeze(['gateway', 'forum', 'game', 'account']);
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(message); };
function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${name}: unexpected or missing fields`);
  }
}
export function validateManifest(input) {
  exact(input, ['version', 'services'], 'manifest');
  if (input.version !== 1 || !Array.isArray(input.services) || input.services.length !== 4) fail('manifest: expected version 1 and four services');
  const seen = new Set();
  const targets = new Set();
  const services = input.services.map((s) => {
    exact(s, ['id', 'testTarget', 'productionTarget', 'artifact', 'configDigest'], 'service');
    if (!SERVICES.includes(s.id) || seen.has(s.id)) fail('service: unknown or duplicate id');
    seen.add(s.id);
    for (const target of [s.testTarget, s.productionTarget]) {
      if (typeof target !== 'string' || !ID.test(target) || targets.has(target)) fail('target: invalid or reused');
      targets.add(target);
    }
    for (const digest of [s.artifact, s.configDigest]) {
      if (typeof digest !== 'string' || !DIGEST.test(digest)) fail('artifact/config: immutable sha256 digest required');
    }
    return { id: s.id, testTarget: s.testTarget, productionTarget: s.productionTarget, artifact: s.artifact, configDigest: s.configDigest };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, services };
}
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Contract laboratory only: no network, shell, credentials or persistent state.
// Actor identity MUST come from an authenticated server in a future adapter.
export function createLab(input) {
  const manifest = validateManifest(input);
  const records = new Map();
  const events = [];
  let sequence = 0;
  const copy = (value) => structuredClone(value);
  function record(service) {
    if (!records.has(service)) fail('unknown service');
    return records.get(service);
  }
  for (const spec of manifest.services) records.set(spec.id, {
    spec, phase: 'ready', approval: null, active: null, previous: null, pendingRollback: null,
  });
  function emit(service, action, actor, detail = {}) {
    events.push({ sequence: ++sequence, service, action, actor: actor.id, role: actor.role, ...detail });
  }
  function binding(r) {
    return fingerprint({ service: r.spec.id, environment: 'production', target: r.spec.productionTarget,
      testTarget: r.spec.testTarget, artifact: r.spec.artifact, configDigest: r.spec.configDigest });
  }
  return Object.freeze({
    snapshot() { return copy({ mode: 'offline-contract-lab', services: [...records.values()], events }); },
    dispatch(request, actor) {
      exact(request, ['service', 'operation', 'params'], 'request');
      exact(actor, ['id', 'role'], 'actor');
      if (typeof actor.id !== 'string' || !ID.test(actor.id) || !['human', 'ai', 'runner'].includes(actor.role)) fail('invalid actor');
      const r = record(request.service);
      const op = request.operation;
      const requirePhase = (...phases) => { if (!phases.includes(r.phase)) fail(`operation ${op} not allowed in ${r.phase}`); };
      const requireRole = (...roles) => { if (!roles.includes(actor.role)) fail(`operation ${op} requires ${roles.join('/')}`); };
      const params = request.params;
      // Validate every branch before mutation. Unknown fields (commands, URLs, secrets)
      // and operations fail closed; there is no arbitrary execution escape hatch.
      switch (op) {
        case 'test':
          exact(params, [], op); requireRole('human', 'ai');
          requirePhase('ready', 'test-failed', 'tested', 'approved');
          r.approval = null; r.phase = 'testing'; break;
        case 'test-result':
          exact(params, ['success'], op); requireRole('runner'); requirePhase('testing');
          if (typeof params.success !== 'boolean') fail('success must be boolean');
          r.phase = params.success ? 'tested' : 'test-failed'; break;
        case 'approve':
          exact(params, ['binding'], op); requireRole('human'); requirePhase('tested');
          if (params.binding !== binding(r)) fail('approval binding mismatch');
          r.approval = { binding: binding(r), actor: actor.id }; r.phase = 'approved'; break;
        case 'promote':
          exact(params, [], op); requireRole('human', 'ai'); requirePhase('approved');
          if (r.approval?.binding !== binding(r)) fail('missing current human approval');
          r.approval = null; r.phase = 'promoting'; break;
        case 'production-result':
          exact(params, ['success'], op); requireRole('runner'); requirePhase('promoting');
          if (typeof params.success !== 'boolean') fail('success must be boolean');
          if (params.success) { r.previous = r.active; r.active = copy(r.spec); r.phase = 'live'; }
          else r.phase = 'production-failed';
          break;
        case 'candidate':
          exact(params, ['artifact', 'configDigest'], op); requireRole('human');
          requirePhase('ready', 'test-failed', 'tested', 'approved', 'live', 'rolled-back');
          if (![params.artifact, params.configDigest].every((d) => typeof d === 'string' && DIGEST.test(d))) fail('immutable digests required');
          if (params.artifact === r.spec.artifact && params.configDigest === r.spec.configDigest) fail('candidate unchanged');
          r.spec.artifact = params.artifact; r.spec.configDigest = params.configDigest;
          r.approval = null; r.phase = 'ready'; break;
        case 'rollback':
          exact(params, [], op); requireRole('human', 'ai'); requirePhase('live', 'production-failed', 'rollback-failed');
          // Failed promotion may have partially changed production: restore active.
          // A successful promotion rolls back to its previous successful release.
          const target = r.phase === 'rollback-failed' ? r.pendingRollback : r.phase === 'production-failed' ? r.active : r.previous;
          if (!target) fail('no known successful rollback target');
          r.pendingRollback = copy(target); r.approval = null; r.phase = 'rolling-back'; break;
        case 'rollback-result':
          exact(params, ['success'], op); requireRole('runner'); requirePhase('rolling-back');
          if (typeof params.success !== 'boolean') fail('success must be boolean');
          if (params.success) {
            r.active = r.pendingRollback; r.spec = copy(r.active); r.previous = null;
            r.pendingRollback = null; r.phase = 'rolled-back';
          } else r.phase = 'rollback-failed';
          break;
        default: fail('unknown operation');
      }
      emit(request.service, op, actor, { phase: r.phase, binding: binding(r), params: copy(params) });
      return copy(r);
    },
    approvalBinding(service) { return binding(record(service)); },
  });
}
