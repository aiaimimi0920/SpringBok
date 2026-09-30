import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLab, SERVICES } from '../contract.mjs';

const actor = { id: 'demo-operator', role: 'human' };
const runner = { id: 'simulated-runner', role: 'runner' };
const manifest = JSON.parse(fs.readFileSync(new URL('../../examples/services.json', import.meta.url)));
const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 1000;
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error('invalid demo fields');
}
export function candidate(service, version) {
  if (!SERVICES.includes(service) || !['v1', 'v2'].includes(version)) throw new Error('invalid demo candidate');
  return { artifact: `sha256:${createHash('sha256').update(`demo:${service}:${version}`).digest('hex')}`,
    configDigest: manifest.services.find(s => s.id === service).configDigest };
}
function newLab() {
  return createLab({ ...manifest, services: manifest.services.map(s => ({ ...s, ...candidate(s.id, 'v1') })) });
}
function apply(lab, input) {
  const { service, action } = input;
  if (!SERVICES.includes(service)) throw new Error('unknown demo service');
  const send = (operation, params = {}, identity = actor) => lab.dispatch({ service, operation, params }, identity);
  switch (action) {
    case 'candidate':
      exact(input, ['service', 'action', 'version']); send('candidate', candidate(service, input.version)); break;
    case 'test': case 'promote': case 'rollback':
      exact(input, ['service', 'action', 'success']);
      if (typeof input.success !== 'boolean') throw new Error('invalid simulated outcome');
      send(action); send({ test: 'test-result', promote: 'production-result', rollback: 'rollback-result' }[action], { success: input.success }, runner); break;
    case 'approve':
      exact(input, ['service', 'action', 'binding', 'acknowledged']);
      if (input.acknowledged !== true) throw new Error('simulation acknowledgement required');
      send('approve', { binding: input.binding }); break;
    default: throw new Error('unknown demo action');
  }
}
// Recovery skips only unconsumed approvals named by a validated restart event.
// Consumed approvals and completed simulated releases are never rewritten.
export function replay(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new Error('invalid demo history');
  let lab = newLab();
  const skipped = new Set();
  const pending = new Map();
  const rebuild = (end) => {
    lab = newLab();
    for (let j = 0; j < end; j++) if (events[j].kind === 'action' && !skipped.has(j + 1)) apply(lab, events[j].input);
  };
  events.forEach((event, index) => {
    if (event.revision !== index + 1) throw new Error('invalid demo sequence');
    if (event.kind === 'action') {
      exact(event, ['revision', 'kind', 'input']);
      apply(lab, event.input);
      const { service, action } = event.input;
      if (action === 'approve') pending.set(service, event.revision);
      else pending.delete(service);
    } else if (event.kind === 'restart') {
      exact(event, ['revision', 'kind', 'invalidated']);
      const expected = [...pending.values()].sort((a, b) => a - b);
      if (!expected.length || JSON.stringify(event.invalidated) !== JSON.stringify(expected)) throw new Error('invalid approval recovery');
      for (const revision of expected) skipped.add(revision);
      pending.clear(); rebuild(index);
    } else throw new Error('unknown demo history event');
  });
  return { lab, pending };
}

export function requireSupportedPlatform(platform = process.platform) {
  if (platform !== 'linux') {
    const error = new Error('M3 demo currently supports Linux only; Windows and macOS persistence are unverified.');
    error.code = 'UNSUPPORTED_PLATFORM'; throw error;
  }
}

export function openStore(directory, { writeFile = atomicWrite } = {}) {
  requireSupportedPlatform();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('demo directory must be a real directory');
  const file = join(directory, 'ledger.json');
  const lock = join(directory, 'owner.lock');
  let fd;
  try { fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error('Demo locked. Stop the other process; see docs/demo-console.md for crash recovery.'); }
  fs.writeFileSync(fd, `${process.pid}\n`); fs.closeSync(fd);
  const lockIdentity = fs.lstatSync(lock);
  let poisoned = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      const current = fs.lstatSync(lock);
      if (current.ino === lockIdentity.ino && current.dev === lockIdentity.dev) fs.unlinkSync(lock);
    } catch { /* Never remove a replacement lock. */ }
  };
  let events = [];
  let projection;
  function commit(next) {
    if (poisoned || closed) throw new Error('Demo storage unavailable; restart after checking the ledger.');
    const candidateProjection = replay(next);
    const bytes = JSON.stringify({ version: 1, mode: 'demo-only', events: next }, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Demo history limit reached; keep this history and use a new checkout.');
    try { writeFile(directory, file, bytes); }
    catch { poisoned = true; throw new Error('Demo storage write failed; no success reported. Stop and inspect before restarting.'); }
    events = next; projection = candidateProjection;
  }
  try {
    if (fs.existsSync(file) || (() => { try { fs.lstatSync(file); return true; } catch { return false; } })()) {
      const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let data;
      try {
        const s = fs.fstatSync(handle);
        if (!s.isFile() || s.size > MAX_BYTES) throw new Error('invalid demo ledger');
        data = JSON.parse(fs.readFileSync(handle, 'utf8'));
      } finally { fs.closeSync(handle); }
      exact(data, ['version', 'mode', 'events']);
      if (data.version !== 1 || data.mode !== 'demo-only') throw new Error('unsupported demo ledger');
      events = data.events; projection = replay(events);
      const invalidated = [...projection.pending.values()].sort((a, b) => a - b);
      if (invalidated.length) commit([...events, { revision: events.length + 1, kind: 'restart', invalidated }]);
    } else commit([]);
  } catch (error) { close(); throw error; }
  return {
    snapshot() {
      if (closed || poisoned) throw new Error('Demo storage unavailable');
      return { mode: 'demo-only', revision: events.length, services: projection.lab.snapshot().services,
        history: structuredClone(events), bindings: Object.fromEntries(SERVICES.map(s => [s, projection.lab.approvalBinding(s)])) };
    },
    action(revision, input) {
      if (revision !== events.length) { const e = new Error('State changed. Refresh before trying again.'); e.status = 409; throw e; }
      commit([...events, { revision: events.length + 1, kind: 'action', input: structuredClone(input) }]);
      return this.snapshot();
    }, close,
  };
}
function atomicWrite(directory, file, bytes) {
  // Reject links instead of following them; rename only touches our fixed ledger name.
  try { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('invalid ledger path'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(directory, `.write-${randomUUID()}`);
  let handle;
  try {
    handle = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); fs.closeSync(handle); handle = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temp); } catch { /* A successful rename already removed it. */ }
  }
}
