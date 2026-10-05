import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { exact } from '../../cloud/protocol.mjs';

export const PACKAGE_FILES = Object.freeze([
  'cloud/catalog-contract.mjs', 'cloud/credential-contract.mjs', 'cloud/enrollment-contract.mjs',
  'cloud/fixture-contract.mjs', 'cloud/node-channel-contract.mjs', 'cloud/node-protocol.mjs', 'cloud/protocol.mjs',
  'scripts/node-run.mjs', 'src/contract.mjs',
  'src/execution/journal.mjs', 'src/execution/plan.mjs', 'src/node-channel/bridge.mjs', 'src/node-channel/client.mjs',
  'src/node-credentials/client.mjs', 'src/node-credentials/files.mjs',
  'src/node-install/install.mjs', 'src/node-install/package.mjs',
]);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function requireInstall(condition) { if (!condition) throw new Error('node installation rejected or uncertain'); }
export function readRegular(file, maximum = 1048576, privateFile = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireInstall(stat.isFile() && stat.size <= maximum && (!privateFile || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0)));
    const data = Buffer.alloc(maximum + 1); let size = 0;
    while (size <= maximum) { const count = fs.readSync(fd, data, size, data.length - size, null); if (!count) break; size += count; }
    requireInstall(size <= maximum); return data.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
export function parseJson(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function manifest(value) {
  exact(value, ['format', 'revision', 'protocolVersion', 'platform', 'minimumNodeMajor', 'files']);
  requireInstall(value.format === 'springbok-control-node/v1' && /^[a-f0-9]{40}$/.test(value.revision) && value.protocolVersion === 2 && value.platform === 'linux' && value.minimumNodeMajor === 22);
  requireInstall(Array.isArray(value.files) && value.files.length === PACKAGE_FILES.length);
  let total = 0;
  value.files.forEach((entry, index) => {
    exact(entry, ['path', 'bytes', 'sha256']);
    requireInstall(entry.path === PACKAGE_FILES[index] && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 1048576 && /^[a-f0-9]{64}$/.test(entry.sha256)); total += entry.bytes;
  });
  requireInstall(total <= 1048576); return value;
}
const PACKAGE_DIRECTORIES = new Set(PACKAGE_FILES.flatMap(path => {
  const parts = path.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}));
function regularTree(directory, privateFiles, prefix = '') {
  const stat = fs.lstatSync(directory);
  requireInstall(stat.isDirectory() && !stat.isSymbolicLink() && (!privateFiles || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0)));
  const files = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  requireInstall(entries.length <= PACKAGE_FILES.length + PACKAGE_DIRECTORIES.size + 1);
  for (const entry of entries) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      requireInstall(PACKAGE_DIRECTORIES.has(path));
      files.push(...regularTree(join(directory, entry.name), privateFiles, path + '/'));
    }
    else { requireInstall(entry.isFile()); files.push(path); }
  }
  return files;
}
export function verifyPackage(directory, expectedSha256, privateFiles = false) {
  requireInstall(typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256));
  const root = fs.lstatSync(directory); requireInstall(root.isDirectory() && !root.isSymbolicLink());
  const bytes = readRegular(join(directory, 'manifest.json'), 16384, privateFiles);
  requireInstall(sha256(bytes) === expectedSha256); const metadata = manifest(parseJson(bytes));
  requireInstall(JSON.stringify(regularTree(directory, privateFiles).sort()) === JSON.stringify([...PACKAGE_FILES, 'manifest.json'].sort()));
  const files = metadata.files.map(entry => {
    const data = readRegular(join(directory, entry.path), entry.bytes, privateFiles);
    requireInstall(data.length === entry.bytes && sha256(data) === entry.sha256); return { path: entry.path, data };
  });
  return { metadata, manifestBytes: bytes, files, sha256: expectedSha256 };
}
export function buildNodePackage({ directory, revision, readSource }) {
  const files = PACKAGE_FILES.map(path => {
    const source = readSource(path); requireInstall(typeof source === 'string' && !source.startsWith('\uFEFF'));
    return { path, data: Buffer.from(source.replaceAll('\r\n', '\n')) };
  });
  const metadata = manifest({ format: 'springbok-control-node/v1', revision, protocolVersion: 2, platform: 'linux', minimumNodeMajor: 22,
    files: files.map(({ path, data }) => ({ path, bytes: data.length, sha256: sha256(data) })) });
  fs.mkdirSync(directory, { mode: 0o755 }); // 独占新目录；失败保留部分产物，不覆盖、不自动清理。
  for (const { path, data } of files) { fs.mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o755 }); fs.writeFileSync(join(directory, path), data, { flag: 'wx', mode: 0o644 }); }
  const bytes = jsonBytes(metadata); fs.writeFileSync(join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o644 });
  return { revision, sha256: sha256(bytes), files: files.length, bytes: files.reduce((size, file) => size + file.data.length, bytes.length) };
}
