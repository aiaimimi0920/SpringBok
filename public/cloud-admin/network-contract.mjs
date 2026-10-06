// 节点、Worker 和浏览器共用；仅校验数据，不导入 Node API 或读取接口。
export const MAX_NETWORK_REPORT_BYTES = 3072;
export const V4_DISK_REPORT_BYTES = 3072;
const TOP = ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'intervalMs', 'interfaces'];
const NUMBERS = ['rxBytes', 'txBytes', 'rxBytesPerSecond', 'txBytesPerSecond'];
const ROW = ['name', 'status', 'reason', ...NUMBERS];
const BASELINE = new Set(['warming-up', 'context-changed', 'interface-set-changed', 'clock-regressed', 'interval-out-of-range', 'interval-too-short']);
const requireNetwork = value => { if (!value) throw new Error('network report denied or unconfirmed'); };
const exact = (value, keys) => requireNetwork(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0 && new Date(value).toISOString() === value;
const copy = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
function normalize(value) {
  exact(value, TOP);
  requireNetwork(value.schema === 'springbok-network/v1' && value.metric === 'network-throughput' && value.scope === 'linux-network-namespace' && value.unit === 'bytes-per-second' && Array.isArray(value.interfaces) && value.interfaces.length <= 256);
  if (value.status === 'unavailable') {
    requireNetwork(['read-failed', 'invalid-counters', 'no-interfaces', 'clock-unavailable', 'report-too-large'].includes(value.reason) && value.sampledAt === null && value.intervalMs === null && value.interfaces.length === 0);
    return { ...copy(value, TOP), interfaces: [] };
  }
  requireNetwork(iso(value.sampledAt) && value.interfaces.length > 0);
  const baseline = value.status === 'unknown' && BASELINE.has(value.reason);
  requireNetwork(baseline ? value.intervalMs === null : Number.isFinite(value.intervalMs) && value.intervalMs >= 30000 && value.intervalMs <= Number.MAX_SAFE_INTEGER / 1000000);
  const names = new Set(); let available = 0;
  const interfaces = value.interfaces.map(row => {
    exact(row, ROW);
    requireNetwork(typeof row.name === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(row.name) && !['.', '..'].includes(row.name) && !names.has(row.name)); names.add(row.name);
    if (row.status === 'unknown') requireNetwork((baseline ? row.reason === value.reason : ['counter-regressed', 'counter-out-of-range'].includes(row.reason)) && NUMBERS.every(key => row[key] === null));
    else {
      requireNetwork(!baseline && row.status === 'available' && row.reason === null && integer(row.rxBytes) && integer(row.txBytes));
      for (const direction of ['rx', 'tx']) {
        const rate = row[`${direction}BytesPerSecond`], expected = row[`${direction}Bytes`] * 1000 / value.intervalMs;
        // 传输 intervalMs 是 IEEE-754；允许两位舍入及浮点转换误差，不重新猜纳秒整数。
        requireNetwork(Number.isFinite(rate) && rate >= 0 && Number.isSafeInteger(Math.round(rate * 100)) && Math.abs(rate * 100 - Math.round(rate * 100)) <= Number.EPSILON * Math.max(1, rate * 100) && Math.abs(rate - expected) <= 0.005 + Number.EPSILON * Math.max(1, rate, expected) * 2);
      }
      available++;
    }
    return copy(row, ROW);
  });
  if (!baseline) requireNetwork(value.status === (available === interfaces.length ? 'available' : available ? 'partial' : 'unknown') && value.reason === (available === interfaces.length ? null : 'interface-unavailable'));
  return { ...copy(value, TOP), interfaces };
}
export function networkReport(value) {
  const normalized = normalize(value);
  return bytes(normalized) <= MAX_NETWORK_REPORT_BYTES ? normalized : { schema: 'springbok-network/v1', metric: 'network-throughput', scope: 'linux-network-namespace', unit: 'bytes-per-second', status: 'unavailable', reason: 'report-too-large', sampledAt: null, intervalMs: null, interfaces: [] };
}
export function networkSample(value) {
  const normalized = normalize(value); requireNetwork(bytes(normalized) <= MAX_NETWORK_REPORT_BYTES); return normalized;
}
