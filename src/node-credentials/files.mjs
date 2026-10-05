import { openSync, fstatSync, readFileSync, closeSync, mkdirSync, lstatSync, writeFileSync, fsyncSync, linkSync, unlinkSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nodeCredential, requireCredential } from '../../cloud/credential-contract.mjs';

export function readPrivateNodeJson(file) {
  requireCredential(process.platform === 'linux');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireCredential(stat.isFile() && stat.size <= 4096 && (stat.mode & 0o077) === 0 && stat.uid === process.getuid());
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)));
  } finally { closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { requireCredential(fstatSync(fd).isDirectory()); fsyncSync(fd); } finally { closeSync(fd); }
}
export function writeRoleCredentials(directory, values, expectedOrigin) {
  const credentials = values.map(value => nodeCredential(value, expectedOrigin));
  requireCredential(process.platform === 'linux' && credentials.length === 2 && credentials[0].role === 'execute' && credentials[1].role === 'observe');
  requireCredential(['origin', 'ownerId', 'nodeId', 'enrollmentId'].every(key => credentials[0][key] === credentials[1][key]) && credentials[0].token !== credentials[1].token);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const stat = lstatSync(directory);
  requireCredential(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid());
  const files = [];
  for (const value of credentials) {
    const file = join(directory, `${value.role}.json`), temp = join(directory, `.credential-${randomUUID()}`);
    let fd, created = false;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      // 原子且不覆盖地发布：一半完成后重试只核对既有文件，不换秘密或覆盖冲突证据。
      try { linkSync(temp, file); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        requireCredential(JSON.stringify(nodeCredential(readPrivateNodeJson(file), expectedOrigin)) === JSON.stringify(value));
      }
      syncDirectory(directory); files.push({ role: value.role, file });
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) { unlinkSync(temp); syncDirectory(directory); }
    }
  }
  return { nodeId: credentials[0].nodeId, enrollmentId: credentials[0].enrollmentId, files };
}
