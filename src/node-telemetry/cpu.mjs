import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const CPU_INTERVAL_MS = 30000;
const MAX_STAT_BYTES = 1048576, MAX_CPUS = 8192, MAX_COUNTER = (1n << 64n) - 1n;

// 只读固定内核入口；procfs 的 st_size 通常为 0，按实际读取字节限量。
export async function readProcStat() {
  if (process.platform !== 'linux') throw new Error('CPU collection requires Linux');
  const file = await open('/proc/stat', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(MAX_STAT_BYTES + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > MAX_STAT_BYTES) throw new Error('CPU counters unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await file.close(); }
}

export function parseCpuStat(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STAT_BYTES) throw new Error('Invalid CPU counters');
  const rows = new Map();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/), id = fields.shift();
    if (!id.startsWith('cpu')) continue;
    if (!/^cpu(?:0|[1-9][0-9]*)?$/.test(id) || rows.has(id) || fields.length !== 10 || fields.some(v => !/^(0|[1-9][0-9]{0,19})$/.test(v))) throw new Error('Invalid CPU counters');
    const values = fields.map(BigInt);
    if (values.some(v => v > MAX_COUNTER) || values[8] > values[0] || values[9] > values[1]) throw new Error('Invalid CPU counters');
    rows.set(id, values);
    if (rows.size > MAX_CPUS + 1) throw new Error('Invalid CPU counters');
  }
  if (!rows.has('cpu') || rows.size < 2) throw new Error('Invalid CPU counters');
  return rows;
}

export function createCpuSampler({ readStat = readProcStat, monotonic = () => performance.now(), wallClock = Date.now } = {}) {
  let previous, inFlight = false;
  return {
    async sample() {
      if (inFlight) throw new Error('CPU collection already running');
      inFlight = true;
      const result = (status, reason, sampledAt, logicalCpuCount = null, intervalMs = null, usagePercent = null) => ({
        schema: 'springbok-cpu/v1', metric: 'cpu', scope: 'linux-proc-stat', unit: 'percent',
        status, reason, sampledAt, logicalCpuCount, intervalMs, usagePercent,
      });
      try {
        let text, rows, sampledAt, now, time;
        try { text = await readStat(); }
        catch { previous = undefined; return result('unavailable', 'read-failed', null); }
        try { rows = parseCpuStat(text); }
        catch { previous = undefined; return result('unavailable', 'invalid-counters', null); }
        try {
          now = monotonic(); time = wallClock();
          if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(time) || time < 0) throw new Error('Invalid clock');
          sampledAt = new Date(time).toISOString();
        } catch { previous = undefined; return result('unavailable', 'clock-unavailable', null); }
        const current = { rows, now, time }, count = rows.size - 1;
        if (!previous) { previous = current; return result('unknown', 'warming-up', sampledAt, count); }
        const before = previous, elapsed = now - before.now;
        if (elapsed <= 0 || time < before.time) {
          previous = current; return result('unknown', 'clock-regressed', sampledAt, count);
        }
        // 过早调用不移动基线，不把两个过短窗口拼成伪 30 秒样本。
        if (elapsed < CPU_INTERVAL_MS) return result('unknown', 'interval-too-short', sampledAt, count);
        previous = current;
        if (rows.size !== before.rows.size || [...rows.keys()].some(id => !before.rows.has(id))) return result('unknown', 'cpu-set-changed', sampledAt, count);
        for (const [id, values] of rows) {
          if (values.some((v, i) => v < before.rows.get(id)[i])) return result('unknown', 'counter-regressed', sampledAt, count);
        }
        const delta = rows.get('cpu').map((v, i) => v - before.rows.get('cpu')[i]);
        // guest/guest_nice 已包含在 user/nice 中；只汇总前八列，避免双计数。
        const total = delta.slice(0, 8).reduce((sum, v) => sum + v, 0n);
        if (!total) return result('unknown', 'no-counter-progress', sampledAt, count);
        const busy = total - delta[3] - delta[4];
        const percent = Number((busy * 10000n + total / 2n) / total) / 100;
        return result('available', null, sampledAt, count, Math.round(elapsed), percent);
      } finally { inFlight = false; }
    },
  };
}
