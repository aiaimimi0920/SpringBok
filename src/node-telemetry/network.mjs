import { constants } from 'node:fs';
import { open, readlink } from 'node:fs/promises';
import { COLLECTION_INTERVAL_MS } from './loop.mjs';

const MAX_DEV_BYTES = 65536, MAX_INTERFACES = 256, MAX_COUNTER = (1n << 64n) - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER), MIN_INTERVAL_NS = BigInt(COLLECTION_INTERVAL_MS) * 1000000n;
const validBoot = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\n$/.test(value);
const validNamespace = value => typeof value === 'string' && /^net:\[[1-9][0-9]{0,19}\]$/.test(value);

async function boundedRead(path, limit, openFile) {
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > limit) throw new Error('Network counters unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await file.close(); }
}

// 只读取当前 namespace 的计数和本地连续性标识；标识不进入输出，不接受用户路径。
export async function readNetworkCounters({ openFile = open, readLink = readlink } = {}) {
  if (process.platform !== 'linux') throw new Error('Network collection requires Linux');
  const namespace = await readLink('/proc/self/ns/net');
  const bootId = await boundedRead('/proc/sys/kernel/random/boot_id', 37, openFile);
  const text = await boundedRead('/proc/self/net/dev', MAX_DEV_BYTES, openFile);
  const afterBoot = await boundedRead('/proc/sys/kernel/random/boot_id', 37, openFile);
  if (!validBoot(bootId) || !validNamespace(namespace) || bootId !== afterBoot || namespace !== await readLink('/proc/self/ns/net')) throw new Error('Network context unavailable');
  return { text, bootId, namespace };
}

export function parseNetworkDev(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DEV_BYTES) throw new Error('Invalid network counters');
  const lines = text.split('\n'), normalize = line => line?.trim().replace(/[ \t]+/g, ' ');
  if (normalize(lines.shift()) !== 'Inter-| Receive | Transmit' || normalize(lines.shift()) !== 'face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed') throw new Error('Invalid network header');
  const rows = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^[ \t]*([a-zA-Z0-9_.-]{1,15}):[ \t]*(.*)$/.exec(line);
    if (!match || ['.', '..'].includes(match[1]) || rows.has(match[1])) throw new Error('Invalid network interface');
    const fields = match[2].trim().split(/[ \t]+/);
    if (fields.length !== 16 || fields.some(value => !/^(0|[1-9][0-9]{0,19})$/.test(value))) throw new Error('Invalid network counters');
    const values = fields.map(BigInt);
    if (values.some(value => value > MAX_COUNTER)) throw new Error('Invalid network counters');
    rows.set(match[1], { rx: values[0], tx: values[8] });
    if (rows.size > MAX_INTERFACES) throw new Error('Too many network interfaces');
  }
  return rows;
}

export function createNetworkSampler({ readCounters = readNetworkCounters, monotonic = () => process.hrtime.bigint(), wallClock = Date.now } = {}) {
  let previous, inFlight = false;
  const result = (status, reason, sampledAt = null, interfaces = [], intervalMs = null) => ({
    schema: 'springbok-network/v1', metric: 'network-throughput', scope: 'linux-network-namespace', unit: 'bytes-per-second',
    status, reason, sampledAt, intervalMs, interfaces,
  });
  const unknownRows = (rows, reason) => [...rows.keys()].sort().map(name => ({ name, status: 'unknown', reason, rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null }));
  return Object.freeze({ async sample() {
    if (inFlight) throw new Error('Network collection already running');
    inFlight = true;
    try {
      let counters, rows, now, time, sampledAt;
      try { counters = await readCounters(); }
      catch { previous = undefined; return result('unavailable', 'read-failed'); }
      try {
        if (!validBoot(counters.bootId) || !validNamespace(counters.namespace)) throw new Error('Invalid context');
        rows = parseNetworkDev(counters.text);
      } catch { previous = undefined; return result('unavailable', 'invalid-counters'); }
      if (!rows.size) { previous = undefined; return result('unavailable', 'no-interfaces'); }
      try {
        now = monotonic(); time = wallClock();
        if (typeof now !== 'bigint' || now < 0n || !Number.isSafeInteger(time) || time < 0) throw new Error('Invalid clock');
        sampledAt = new Date(time).toISOString();
      } catch { previous = undefined; return result('unavailable', 'clock-unavailable'); }
      const current = { rows, now, time, bootId: counters.bootId, namespace: counters.namespace };
      const reset = reason => { previous = current; return result('unknown', reason, sampledAt, unknownRows(rows, reason)); };
      if (!previous) return reset('warming-up');
      const before = previous, elapsed = now - before.now;
      if (current.bootId !== before.bootId || current.namespace !== before.namespace) return reset('context-changed');
      if (rows.size !== before.rows.size || [...rows.keys()].some(name => !before.rows.has(name))) return reset('interface-set-changed');
      if (elapsed <= 0n || time < before.time) return reset('clock-regressed');
      if (elapsed > MAX_SAFE) return reset('interval-out-of-range');
      // 过早调用不移动基线；正常循环至少等待 30 秒，延迟不补采。
      if (elapsed < MIN_INTERVAL_NS) return result('unknown', 'interval-too-short', sampledAt, unknownRows(rows, 'interval-too-short'));
      previous = current;
      const interfaces = [...rows.keys()].sort().map(name => {
        const delta = { rx: rows.get(name).rx - before.rows.get(name).rx, tx: rows.get(name).tx - before.rows.get(name).tx };
        const unavailable = reason => unknownRows(new Map([[name, null]]), reason)[0];
        if (delta.rx < 0n || delta.tx < 0n) return unavailable('counter-regressed');
        // 累计量可超过 Number 精度；只在差分和百分之一 bytes/s 均安全后转换。
        const rxRate = (delta.rx * 100000000000n + elapsed / 2n) / elapsed;
        const txRate = (delta.tx * 100000000000n + elapsed / 2n) / elapsed;
        if ([delta.rx, delta.tx, rxRate, txRate].some(value => value > MAX_SAFE)) return unavailable('counter-out-of-range');
        return { name, status: 'available', reason: null, rxBytes: Number(delta.rx), txBytes: Number(delta.tx), rxBytesPerSecond: Number(rxRate) / 100, txBytesPerSecond: Number(txRate) / 100 };
      });
      const available = interfaces.filter(row => row.status === 'available').length;
      return result(available === interfaces.length ? 'available' : available ? 'partial' : 'unknown', available === interfaces.length ? null : 'interface-unavailable', sampledAt, interfaces, Number(elapsed) / 1000000);
    } finally { inFlight = false; }
  } });
}
