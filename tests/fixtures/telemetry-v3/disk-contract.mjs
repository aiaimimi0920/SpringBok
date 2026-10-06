// 浏览器、Worker 和节点共用的纯数据契约；不导入 Node API，不读取或探测路径。
export const MAX_DISK_REPORT_BYTES = 6144;
const FIELDS = ['totalBytes', 'freeBytes', 'availableBytes', 'usedBytes', 'reservedBytes', 'usagePercent'];
const TOP = ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'mounts', 'filtered'];
const MOUNT = ['mountId', 'device', 'mountPoint', 'fsType', 'readOnly', 'status', 'reason', ...FIELDS];
const FILTER = ['pseudo', 'unsupported', 'subtree', 'unsafeTopology'];
const TYPES = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs']);
const requireDisk = value => { if (!value) throw new Error('disk report denied or unconfirmed'); };
const exact = (value, keys) => requireDisk(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0 && new Date(value).toISOString() === value;
const copy = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
function normalize(value) {
  exact(value, TOP);
  requireDisk(value.schema === 'springbok-disk/v1' && value.metric === 'disk-capacity' && value.scope === 'linux-mount-namespace' && value.unit === 'bytes' && Array.isArray(value.mounts) && value.mounts.length <= 32);
  if (value.filtered === null) {
    requireDisk(value.status === 'unavailable' && value.sampledAt === null && !value.mounts.length && ['read-failed', 'invalid-mountinfo', 'mount-limit', 'mounts-changed', 'clock-unavailable', 'worker-failed', 'worker-timeout', 'worker-busy', 'stopped', 'report-too-large'].includes(value.reason));
    return { ...copy(value, TOP), mounts: [] };
  }
  exact(value.filtered, FILTER);
  requireDisk(iso(value.sampledAt) && FILTER.every(key => integer(value.filtered[key])) && FILTER.reduce((n, key) => n + value.filtered[key], value.mounts.length) <= 4096);
  const ids = new Set(), paths = new Set(); let available = 0;
  const mounts = value.mounts.map(mount => {
    exact(mount, MOUNT);
    const path = mount.mountPoint;
    requireDisk(integer(mount.mountId) && mount.mountId > 0 && !ids.has(mount.mountId) && typeof mount.device === 'string' && /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/.test(mount.device));
    requireDisk(typeof path === 'string' && path.isWellFormed() && path.startsWith('/') && !path.includes('\0') && new TextEncoder().encode(path).length <= 4096 && (path === '/' || path.slice(1).split('/').every(part => part && part !== '.' && part !== '..')) && !paths.has(path) && TYPES.has(mount.fsType) && typeof mount.readOnly === 'boolean');
    ids.add(mount.mountId); paths.add(path);
    if (mount.status === 'unavailable') requireDisk(['path-unavailable', 'statfs-failed', 'invalid-statfs'].includes(mount.reason) && FIELDS.every(key => mount[key] === null));
    else {
      requireDisk(mount.status === 'available' && mount.reason === null && FIELDS.slice(0, -1).every(key => integer(mount[key])) && mount.totalBytes > 0 && mount.freeBytes <= mount.totalBytes && mount.availableBytes <= mount.freeBytes && mount.usedBytes === mount.totalBytes - mount.freeBytes && mount.reservedBytes === mount.freeBytes - mount.availableBytes);
      const used = BigInt(mount.usedBytes), denominator = used + BigInt(mount.availableBytes);
      requireDisk(denominator > 0n && mount.usagePercent === Number((used * 10000n + denominator / 2n) / denominator) / 100);
      available++;
    }
    return copy(mount, MOUNT);
  });
  const status = available === mounts.length && available > 0 ? 'available' : available > 0 ? 'partial' : 'unavailable';
  requireDisk(value.status === status && value.reason === (status === 'available' ? null : mounts.length ? 'mount-unavailable' : 'no-supported-mounts'));
  return { ...copy(value, TOP), mounts, filtered: copy(value.filtered, FILTER) };
}
// 不截断挂载点、路径或字段；完整规范化 JSON 超预算时仅报告整体未上报。
export function diskReport(value) {
  const normalized = normalize(value);
  return bytes(normalized) <= MAX_DISK_REPORT_BYTES ? normalized : { schema: 'springbok-disk/v1', metric: 'disk-capacity', scope: 'linux-mount-namespace', unit: 'bytes', status: 'unavailable', reason: 'report-too-large', sampledAt: null, mounts: [], filtered: null };
}
export function diskSample(value) {
  const normalized = normalize(value); requireDisk(bytes(normalized) <= MAX_DISK_REPORT_BYTES); return normalized;
}
