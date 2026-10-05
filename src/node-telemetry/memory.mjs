import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const MAX_MEMINFO_BYTES = 65536, MAX_BYTES = BigInt(Number.MAX_SAFE_INTEGER);

// 只读固定内核入口；按实际字节限量，不使用 procfs 通常为 0 的 st_size。
export async function readProcMeminfo({ openFile = open } = {}) {
  if (process.platform !== 'linux') throw new Error('Memory collection requires Linux');
  const file = await openFile('/proc/meminfo', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(MAX_MEMINFO_BYTES + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > MAX_MEMINFO_BYTES) throw new Error('Memory information unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await file.close(); }
}

export function parseMemoryInfo(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_MEMINFO_BYTES) throw new Error('Invalid memory information');
  const fields = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!/^Mem(?:Total|Available)(?=:|\s|$)/.test(trimmed)) continue;
    const match = /^(MemTotal|MemAvailable):[ \t]+(0|[1-9][0-9]{0,15})[ \t]+kB[ \t]*$/.exec(trimmed);
    if (!match || fields.has(match[1])) throw new Error('Invalid memory information');
    const bytes = BigInt(match[2]) * 1024n;
    if (bytes > MAX_BYTES) throw new Error('Invalid memory information');
    fields.set(match[1], bytes);
  }
  const total = fields.get('MemTotal'), available = fields.get('MemAvailable');
  if (total === undefined || total === 0n || (available !== undefined && available > total)) throw new Error('Invalid memory information');
  if (available === undefined) return null; // 不用 MemFree/缓存加总猜测旧内核的可用量。
  const used = total - available;
  return { totalBytes: Number(total), availableBytes: Number(available), usedBytes: Number(used),
    usagePercent: Number((used * 10000n + total / 2n) / total) / 100 };
}

export function createMemorySampler({ readMeminfo = readProcMeminfo, wallClock = Date.now } = {}) {
  let inFlight = false;
  return Object.freeze({ async sample() {
    if (inFlight) throw new Error('Memory collection already running');
    inFlight = true;
    const result = (status, reason, sampledAt = null, reading = null) => ({
      schema: 'springbok-memory/v1', metric: 'memory', scope: 'linux-proc-meminfo', unit: 'bytes',
      status, reason, sampledAt, totalBytes: reading?.totalBytes ?? null,
      availableBytes: reading?.availableBytes ?? null, usedBytes: reading?.usedBytes ?? null,
      usagePercent: reading?.usagePercent ?? null,
    });
    try {
      let text, reading, sampledAt;
      try { text = await readMeminfo(); }
      catch { return result('unavailable', 'read-failed'); }
      try { reading = parseMemoryInfo(text); }
      catch { return result('unavailable', 'invalid-meminfo'); }
      if (reading === null) return result('unavailable', 'memavailable-missing');
      try {
        const time = wallClock();
        if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid clock');
        sampledAt = new Date(time).toISOString();
      } catch { return result('unavailable', 'clock-unavailable'); }
      // 内存是时点 gauge，不复用 CPU 差分基线或预热，也不保留故障前的陈旧值。
      return result('available', null, sampledAt, reading);
    } finally { inFlight = false; }
  } });
}
