import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exact } from './plan.mjs';

const MAX_BYTES = 1024 * 1024;
export function atomicWrite(directory, file, bytes) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw new Error('invalid execution ledger'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(directory, `.write-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* A completed rename already removed it. */ }
  }
}

export function openJournal(directory, binding, validate, { writeFile = atomicWrite } = {}) {
  if (process.platform !== 'linux') throw new Error('execution journal currently supports Linux only');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('execution directory must be real');
  const lock = join(directory, 'owner.lock'), file = join(directory, 'ledger.json');
  let fd;
  try { fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error('execution journal locked; preserve and inspect it before recovery'); }
  fs.writeFileSync(fd, `${process.pid}\n`); fs.closeSync(fd);
  const identity = fs.lstatSync(lock);
  let closed = false, poisoned = false, events = [];
  const available = () => { if (closed || poisoned) throw new Error('execution journal unavailable'); };
  const close = () => {
    if (closed) return; closed = true;
    try { const current = fs.lstatSync(lock); if (current.ino === identity.ino && current.dev === identity.dev) fs.unlinkSync(lock); }
    catch { /* Never remove another process's replacement lock. */ }
  };
  function commit(next) {
    available();
    if (next.length > 1000) throw new Error('execution history limit reached');
    validate(next);
    const bytes = JSON.stringify({ version: 1, mode: 'execution-recovery-lab', binding, events: next }, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('execution history limit reached');
    try { writeFile(directory, file, bytes); }
    catch { poisoned = true; throw new Error('execution journal write uncertain; stop and inspect before restarting'); }
    events = next;
  }
  try {
    let handle;
    try { handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (handle !== undefined) {
      let data;
      try {
        const s = fs.fstatSync(handle);
        if (!s.isFile() || s.size > MAX_BYTES) throw new Error('invalid execution ledger');
        data = JSON.parse(fs.readFileSync(handle, 'utf8'));
      } finally { fs.closeSync(handle); }
      exact(data, ['version', 'mode', 'binding', 'events']);
      if (data.version !== 1 || data.mode !== 'execution-recovery-lab' || data.binding !== binding) throw new Error('execution ledger binding mismatch');
      validate(data.events); events = data.events;
    } else commit([]);
  } catch (error) { close(); throw error; }
  return Object.freeze({
    read() { available(); return structuredClone(events); },
    append(event) { commit([...events, { ...structuredClone(event), revision: events.length + 1 }]); },
    close,
  });
}
