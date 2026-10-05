import * as fs from 'node:fs';
import { join } from 'node:path';

export function lockDaemon(directory) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('daemon requires a non-root Linux uid');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('invalid daemon state directory');
  const file = join(directory, 'daemon.lock');
  // 已存在的锁一律保留，不按 PID/时间猜测死亡，也不从这里清理原 journal 锁。
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let identity;
  try { identity = fs.fstatSync(fd); fs.writeFileSync(fd, `${process.pid}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  let closed = false;
  return () => {
    if (closed) return; closed = true;
    try {
      const current = fs.lstatSync(file);
      if (current.ino === identity.ino && current.dev === identity.dev && current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
