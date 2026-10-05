import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, dirname } from 'node:path';
import { verifyInstallation } from '../node-install/install.mjs';
import { readRegular, requireInstall } from '../node-install/package.mjs';

// 不实现 shell/systemd 转义语言；只接受可直接放进固定 unit 的规范绝对路径。
function safePath(path) {
  requireInstall(typeof path === 'string' && isAbsolute(path) && /^\/[A-Za-z0-9_./-]+$/.test(path));
  requireInstall(fs.realpathSync(path) === path);
  return path;
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function userUnit({ installation }) {
  const nodeExecutable = process.execPath;
  safePath(installation); safePath(nodeExecutable);
  const executable = fs.statSync(nodeExecutable);
  requireInstall(executable.isFile() && [0, process.getuid()].includes(executable.uid) && (executable.mode & 0o022) === 0 && (executable.mode & 0o111) !== 0);
  const installed = verifyInstallation(installation), role = installed.record.context.role;
  const name = `springbok-control-${role}.service`;
  const contents = `[Unit]\nDescription=SpringBok ${role} control client\n\n[Service]\nType=exec\nExecStart=${nodeExecutable} ${join(installation, 'release/scripts/node-daemon.mjs')} --installation ${installation}\nWorkingDirectory=${installation}\nUMask=0077\nRestart=no\nKillSignal=SIGTERM\nKillMode=control-group\nTimeoutStopSec=30s\nNoNewPrivileges=yes\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
  requireInstall(Buffer.byteLength(contents) <= 4096);
  return { name, contents, role, revision: installed.record.revision, executionReady: false };
}
export function installUserUnit({ installation, unitDirectory }) {
  const unit = userUnit({ installation });
  safePath(unitDirectory);
  const directory = fs.lstatSync(unitDirectory);
  requireInstall(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o077) === 0);
  const path = join(unitDirectory, unit.name), bytes = Buffer.from(unit.contents);
  function matches() { requireInstall(readRegular(path, 4096, true).equals(bytes)); }
  try { matches(); return { ...unit, path, status: 'verified' }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(unitDirectory, `.springbok-unit-${randomUUID()}`); let fd, created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); created = true;
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; matches(); }
    syncDirectory(unitDirectory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) { fs.unlinkSync(temporary); syncDirectory(dirname(temporary)); }
  }
  matches();
  return { ...unit, path, status: 'installed' };
}
