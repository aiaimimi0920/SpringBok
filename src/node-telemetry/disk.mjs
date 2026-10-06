import { constants } from 'node:fs';
import { open, lstat, realpath, statfs } from 'node:fs/promises';
import { posix } from 'node:path';

export const MAX_MOUNTINFO_BYTES = 524288, MAX_MOUNT_ENTRIES = 4096, MAX_DISK_MOUNTS = 32;
const MAX_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
// 仅支持已核对 Linux statfs 单位的本地实现；overlay 转发到未知底层，不能只凭 magic 推定单位。
const TYPES = new Map([['ext2', 0xef53n], ['ext3', 0xef53n], ['ext4', 0xef53n],
  ['xfs', 0x58465342n], ['btrfs', 0x9123683en]]);
const PSEUDO = new Set(['proc', 'sysfs', 'tmpfs', 'ramfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2',
  'securityfs', 'debugfs', 'tracefs', 'configfs', 'pstore', 'mqueue', 'hugetlbfs', 'bpf', 'nsfs', 'fusectl']);
const FIELD_NAMES = ['totalBytes', 'freeBytes', 'availableBytes', 'usedBytes', 'reservedBytes', 'usagePercent'];
const emptyReading = () => Object.fromEntries(FIELD_NAMES.map(name => [name, null]));
const id = value => /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const device = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/.test(value);
const pathValid = value => typeof value === 'string' && value.isWellFormed() && value.startsWith('/') && (value === '/' || !value.endsWith('/')) && !value.includes('\0') &&
  Buffer.byteLength(value, 'utf8') <= 4096 && posix.normalize(value) === value;
const prefix = (parent, child) => parent === '/' || child.startsWith(parent + '/');

export async function readMountInfo({ openFile = open } = {}) {
  if (process.platform !== 'linux') throw new Error('Disk collection requires Linux');
  const file = await openFile('/proc/self/mountinfo', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(MAX_MOUNTINFO_BYTES + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > MAX_MOUNTINFO_BYTES) throw new Error('Mount information unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await file.close(); }
}

function decodePath(value) {
  // 内核 mountinfo 的四种转义；不解码任意八进制，也不规范化改变实际路径。
  if (/\\(?!040|011|012|134)/.test(value)) throw new Error('Invalid mount path');
  const decoded = value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  if (!pathValid(decoded)) throw new Error('Invalid mount path');
  return decoded;
}

export function parseMountInfo(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || Buffer.byteLength(text, 'utf8') > MAX_MOUNTINFO_BYTES) throw new Error('Invalid mount information');
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines.length > MAX_MOUNT_ENTRIES) throw new Error('Invalid mount information');
  const seen = new Set();
  return lines.map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-', 6);
    if (fields.some(field => !field || /[\x00-\x1f\x7f]/.test(field)) || separator < 6 || fields.length !== separator + 4 ||
        !id(fields[0]) || !id(fields[1]) || fields[0] === fields[1] || !device(fields[2]) || seen.has(fields[0]) ||
        !/^[a-zA-Z0-9_.-]{1,64}$/.test(fields[separator + 1])) throw new Error('Invalid mount information');
    const options = fields[5].split(',');
    if (options.filter(option => option === 'ro' || option === 'rw').length !== 1) throw new Error('Invalid mount information');
    seen.add(fields[0]);
    return { mountId: Number(fields[0]), parentId: Number(fields[1]), device: fields[2], root: decodePath(fields[3]),
      mountPoint: decodePath(fields[4]), fsType: fields[separator + 1], readOnly: options.includes('ro') };
    // source、optional fields、super options 留在私有原文本，仅用于前后拓扑比较，绝不进入结果。
  });
}

export function selectDiskMounts(entries) {
  const byId = new Map(entries.map(entry => [entry.mountId, entry])), byPath = new Map();
  const filtered = { pseudo: 0, unsupported: 0, subtree: 0, unsafeTopology: 0 }, mounts = [];
  for (const entry of entries) byPath.set(entry.mountPoint, [...(byPath.get(entry.mountPoint) ?? []), entry]);
  function safe(entry) {
    if (!byPath.has('/')) return false;
    const visited = new Set([entry.mountId]); let current = entry;
    while (byId.has(current.parentId)) {
      const parent = byId.get(current.parentId);
      if (visited.has(parent.mountId) || !prefix(parent.mountPoint, current.mountPoint) ||
          parent.mountPoint === current.mountPoint || !TYPES.has(parent.fsType)) return false;
      visited.add(parent.mountId); current = parent;
    }
    for (const [path, group] of byPath) {
      if (path !== entry.mountPoint && !prefix(path, entry.mountPoint)) continue;
      if (group.length !== 1 || !TYPES.has(group[0].fsType)) return false;
      // 路径祖先必须也在 mount parent 链中，避免对隐藏条目 statfs 后套错 mount ID。
      if (!visited.has(group[0].mountId)) return false;
    }
    return true;
  }
  for (const entry of entries) {
    if (PSEUDO.has(entry.fsType)) filtered.pseudo++;
    else if (!TYPES.has(entry.fsType)) filtered.unsupported++;
    else if (entry.root !== '/') filtered.subtree++; // 首版不重复统计 bind/subvolume 子树或 file bind。
    else if (!safe(entry)) filtered.unsafeTopology++;
    else mounts.push(entry);
  }
  return { mounts, filtered };
}

export function diskCapacity(stats, fsType) {
  const { type, bsize, blocks, bfree, bavail } = stats;
  if (!TYPES.has(fsType) || [type, bsize, blocks, bfree, bavail].some(value => typeof value !== 'bigint') ||
      type !== TYPES.get(fsType) || bsize <= 0n || blocks <= 0n || bfree < 0n || bavail < 0n || bfree > blocks || bavail > bfree) throw new Error('Invalid disk statistics');
  const total = blocks * bsize, free = bfree * bsize, available = bavail * bsize, used = total - free, reserved = free - available;
  if (total > MAX_BYTES || used + available === 0n) throw new Error('Invalid disk statistics');
  return { totalBytes: Number(total), freeBytes: Number(free), availableBytes: Number(available), usedBytes: Number(used),
    reservedBytes: Number(reserved), usagePercent: Number((used * 10000n + (used + available) / 2n) / (used + available)) / 100 };
}

export function unavailableDisk(reason) {
  return { schema: 'springbok-disk/v1', metric: 'disk-capacity', scope: 'linux-mount-namespace', unit: 'bytes',
    status: 'unavailable', reason, sampledAt: null, mounts: [], filtered: null };
}

async function verifyMountPath(path) {
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Mount path unavailable');
}

// 只能在自有采样 worker 内调用真实 statfs；进程内 timeout 不能取消内核 I/O。
export async function collectDisk({ readInfo = readMountInfo, readStats = path => statfs(path, { bigint: true }),
  verifyPath = verifyMountPath, wallClock = Date.now } = {}) {
  let before, selection;
  try { before = await readInfo(); } catch { return unavailableDisk('read-failed'); }
  try { selection = selectDiskMounts(parseMountInfo(before)); } catch { return unavailableDisk('invalid-mountinfo'); }
  if (selection.mounts.length > MAX_DISK_MOUNTS) return unavailableDisk('mount-limit');
  const mounts = [];
  for (const entry of selection.mounts) {
    const { mountId, device, mountPoint, fsType, readOnly } = entry;
    const result = { mountId, device, mountPoint, fsType, readOnly, status: 'unavailable', reason: null, ...emptyReading() };
    try { await verifyPath(mountPoint); } catch { result.reason = 'path-unavailable'; mounts.push(result); continue; }
    let stats;
    try { stats = await readStats(mountPoint); } catch { result.reason = 'statfs-failed'; mounts.push(result); continue; }
    try { Object.assign(result, diskCapacity(stats, fsType), { status: 'available' }); }
    catch { result.reason = 'invalid-statfs'; }
    mounts.push(result);
  }
  let after;
  try { after = await readInfo(); } catch { return unavailableDisk('read-failed'); }
  if (before !== after) return unavailableDisk('mounts-changed'); // 非原子快照，仍不能排除 ABA。
  let sampledAt;
  try {
    const now = wallClock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock');
    sampledAt = new Date(now).toISOString();
  } catch { return unavailableDisk('clock-unavailable'); }
  const available = mounts.filter(mount => mount.status === 'available').length;
  return { ...unavailableDisk(null), status: available === mounts.length && available > 0 ? 'available' : available > 0 ? 'partial' : 'unavailable',
    reason: available === mounts.length && available > 0 ? null : mounts.length ? 'mount-unavailable' : 'no-supported-mounts',
    sampledAt, mounts, filtered: selection.filtered };
}

// 自有子进程出口亦严格验证；stdout 不允许附带原始 mount source/options 或异常文本。
export function isDiskSample(value) {
  const keys = (object, names) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).sort().join(',') === [...names].sort().join(',');
  if (!keys(value, ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'mounts', 'filtered']) ||
      value.schema !== 'springbok-disk/v1' || value.metric !== 'disk-capacity' || value.scope !== 'linux-mount-namespace' || value.unit !== 'bytes' ||
      !Array.isArray(value.mounts) || value.mounts.length > MAX_DISK_MOUNTS) return false;
  if (value.filtered === null) return value.status === 'unavailable' && value.sampledAt === null && !value.mounts.length &&
    ['read-failed', 'invalid-mountinfo', 'mount-limit', 'mounts-changed', 'clock-unavailable', 'worker-failed', 'worker-timeout', 'worker-busy', 'stopped'].includes(value.reason);
  if (!keys(value.filtered, ['pseudo', 'unsupported', 'subtree', 'unsafeTopology']) ||
      Object.values(value.filtered).some(count => !Number.isInteger(count) || count < 0) ||
      Object.values(value.filtered).reduce((sum, count) => sum + count, value.mounts.length) > MAX_MOUNT_ENTRIES ||
      typeof value.sampledAt !== 'string' || !Number.isFinite(Date.parse(value.sampledAt)) || Date.parse(value.sampledAt) < 0 ||
      new Date(value.sampledAt).toISOString() !== value.sampledAt) return false;
  const seen = new Set(), paths = new Set(); let available = 0;
  for (const mount of value.mounts) {
    if (!keys(mount, ['mountId', 'device', 'mountPoint', 'fsType', 'readOnly', 'status', 'reason', ...FIELD_NAMES]) ||
        !Number.isSafeInteger(mount.mountId) || mount.mountId <= 0 || seen.has(mount.mountId) || !device(mount.device) ||
        !pathValid(mount.mountPoint) || paths.has(mount.mountPoint) || !TYPES.has(mount.fsType) || typeof mount.readOnly !== 'boolean') return false;
    seen.add(mount.mountId); paths.add(mount.mountPoint);
    if (mount.status === 'unavailable') {
      if (!['path-unavailable', 'statfs-failed', 'invalid-statfs'].includes(mount.reason) || FIELD_NAMES.some(name => mount[name] !== null)) return false;
    } else if (mount.status === 'available') {
      if (mount.reason !== null || FIELD_NAMES.slice(0, -1).some(name => !Number.isSafeInteger(mount[name]) || mount[name] < 0) || mount.totalBytes === 0 ||
          mount.freeBytes > mount.totalBytes || mount.availableBytes > mount.freeBytes || mount.usedBytes !== mount.totalBytes - mount.freeBytes ||
          mount.reservedBytes !== mount.freeBytes - mount.availableBytes || mount.usedBytes + mount.availableBytes === 0) return false;
      const used = BigInt(mount.usedBytes), denominator = used + BigInt(mount.availableBytes);
      if (mount.usagePercent !== Number((used * 10000n + denominator / 2n) / denominator) / 100) return false;
      available++;
    } else return false;
  }
  const status = available === value.mounts.length && available > 0 ? 'available' : available > 0 ? 'partial' : 'unavailable';
  return value.status === status && value.reason === (status === 'available' ? null : value.mounts.length ? 'mount-unavailable' : 'no-supported-mounts');
}
