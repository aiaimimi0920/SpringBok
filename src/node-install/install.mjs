import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { nodeCredential, nodeRole, pinnedOrigin } from '../../cloud/credential-contract.mjs';
import { nodeContext } from '../../cloud/node-protocol.mjs';
import { isUuid } from '../../cloud/catalog-contract.mjs';
import { exact } from '../../cloud/protocol.mjs';
import { verifyPackage, readRegular, parseJson, jsonBytes, sha256, requireInstall } from './package.mjs';

function runtime() { requireInstall(process.platform === 'linux' && process.getuid() !== 0 && Number(process.versions.node.split('.')[0]) >= 22); }
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  requireInstall(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(dirname(directory)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateDirectory(directory);
}
function matchesFile(file, data) { requireInstall(readRegular(file, data.length, true).equals(data)); }
function publish(directory, file, data) {
  try { matchesFile(file, data); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(directory, `.install-${randomUUID()}`); let fd, created = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); created = true;
    fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; matchesFile(file, data); }
    syncDirectory(directory);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (created) { fs.unlinkSync(temp); syncDirectory(directory); } }
}
function contextOf(credential) {
  return { origin: credential.origin, ownerId: credential.ownerId, nodeId: credential.nodeId, enrollmentId: credential.enrollmentId, role: credential.role };
}
function installation(value) {
  exact(value, ['format', 'uid', 'revision', 'packageSha256', 'credentialSha256', 'context']);
  requireInstall(value.format === 'springbok-role-install/v1' && value.uid === process.getuid() && /^[a-f0-9]{40}$/.test(value.revision) && /^[a-f0-9]{64}$/.test(value.packageSha256) && /^[a-f0-9]{64}$/.test(value.credentialSha256));
  const c = value.context; exact(c, ['origin', 'ownerId', 'nodeId', 'enrollmentId', 'role']);
  pinnedOrigin(c.origin); nodeContext({ ownerId: c.ownerId, nodeId: c.nodeId }); nodeRole(c.role); requireInstall(isUuid(c.enrollmentId)); return value;
}
function summary(record, status) {
  return { status, revision: record.revision, packageSha256: record.packageSha256, protocolVersion: 2, ...record.context, executionReady: false };
}
export function verifyInstallation(directory) {
  runtime(); directory = resolve(directory); privateDirectory(directory); requireInstall(fs.realpathSync(directory) === directory);
  const bytes = readRegular(join(directory, 'install.json'), 4096, true), record = installation(parseJson(bytes));
  matchesFile(join(directory, 'complete.json'), bytes);
  const bundle = verifyPackage(join(directory, 'release'), record.packageSha256, true);
  requireInstall(bundle.metadata.revision === record.revision);
  privateDirectory(join(directory, 'state'));
  const credentialFile = join(directory, 'credential.json'), credential = nodeCredential(parseJson(readRegular(credentialFile, 4096, true)), record.context.origin);
  requireInstall(sha256(jsonBytes(credential)) === record.credentialSha256 && JSON.stringify(contextOf(credential)) === JSON.stringify(record.context));
  return { record, credentialFile, stateDirectory: join(directory, 'state'), summary: summary(record, 'verified') };
}
export function installNode({ packageDirectory, expectedSha256, credentialFile, expectedOrigin, role, directory }) {
  runtime(); const bundle = verifyPackage(packageDirectory, expectedSha256), credential = nodeCredential(parseJson(readRegular(credentialFile, 4096, true)), expectedOrigin);
  requireInstall(credential.role === nodeRole(role));
  directory = resolve(directory); const parent = dirname(directory);
  requireInstall(directory !== parent && fs.realpathSync(parent) === parent);
  const record = installation({ format: 'springbok-role-install/v1', uid: process.getuid(), revision: bundle.metadata.revision, packageSha256: bundle.sha256, credentialSha256: sha256(jsonBytes(credential)), context: contextOf(credential) });
  const marker = jsonBytes(record); let created = false;
  try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; syncDirectory(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateDirectory(directory);
  if (created) publish(directory, join(directory, 'install.json'), marker);
  else matchesFile(join(directory, 'install.json'), marker); // 不收编无标记目录，也不改绑定。
  let complete = false;
  try { readRegular(join(directory, 'complete.json'), 4096, true); complete = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 只捕获 complete 本身不存在；完整安装内任何 ENOENT 均传播，绝不转入恢复。
  if (complete) return verifyInstallation(directory).summary;
  const release = join(directory, 'release'); ensureDirectory(release); ensureDirectory(join(directory, 'state'));
  for (const { path, data } of bundle.files) {
    let current = release;
    for (const component of dirname(path).split('/')) { current = join(current, component); ensureDirectory(current); }
    publish(current, join(release, path), data);
  }
  publish(release, join(release, 'manifest.json'), bundle.manifestBytes);
  publish(directory, join(directory, 'credential.json'), jsonBytes(credential));
  verifyPackage(release, bundle.sha256, true);
  publish(directory, join(directory, 'complete.json'), marker);
  return { ...verifyInstallation(directory).summary, status: 'installed' };
}
