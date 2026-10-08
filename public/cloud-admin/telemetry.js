import { diskSample } from './disk-contract.mjs';
import { networkSample, V4_DISK_REPORT_BYTES } from './network-contract.mjs';
let generation = 0, controller;
const timers = new Set();
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0 && new Date(value).toISOString() === value;
function cpuLines(cpu, state) {
  try {
    if (!exact(cpu, ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'logicalCpuCount', 'intervalMs', 'usagePercent']) || cpu.schema !== 'springbok-cpu/v1' || cpu.metric !== 'cpu' || cpu.scope !== 'linux-proc-stat' || cpu.unit !== 'percent' || !['available', 'unknown', 'unavailable'].includes(cpu.status)) throw new Error('cpu unconfirmed');
    if (cpu.status === 'available' ? !Number.isFinite(cpu.usagePercent) || cpu.usagePercent < 0 || cpu.usagePercent > 100 || !integer(cpu.intervalMs) || cpu.intervalMs < 30000 || cpu.reason !== null : cpu.usagePercent !== null || cpu.intervalMs !== null) throw new Error('cpu value unconfirmed');
    if (cpu.status === 'unavailable' ? cpu.sampledAt !== null || cpu.logicalCpuCount !== null || !['read-failed', 'invalid-counters', 'clock-unavailable'].includes(cpu.reason) : !iso(cpu.sampledAt) || !integer(cpu.logicalCpuCount) || cpu.logicalCpuCount < 1 || cpu.logicalCpuCount > 8192 || (cpu.status === 'unknown' && !['warming-up', 'clock-regressed', 'interval-too-short', 'cpu-set-changed', 'counter-regressed', 'no-counter-progress'].includes(cpu.reason))) throw new Error('cpu collection unconfirmed');
    const reading = cpu.status === 'available' ? `${cpu.usagePercent.toFixed(2)}%` : cpu.status === 'unavailable' ? '采集不可用' : '采集未知';
    return [`CPU：${reading}；${state}${cpu.reason ? `；${cpu.reason}` : ''}`, `CPU 采样时间 ${cpu.sampledAt ?? '无'}；范围 linux-proc-stat；逻辑 CPU ${cpu.logicalCpuCount ?? '未知'}；实际窗口 ${cpu.intervalMs ?? '未知'} ms。`];
  } catch { return ['CPU 未确认：当前值未知。']; }
}
function memoryLines(sample, state) {
  if (!Object.hasOwn(sample, 'sampleVersion') && !Object.hasOwn(sample, 'memory')) return ['内存未上报：旧 CPU-only 样本。'];
  try {
    const m = sample.memory;
    if (![2, 3, 4].includes(sample.sampleVersion) || !exact(m, ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'totalBytes', 'availableBytes', 'usedBytes', 'usagePercent']) || m.schema !== 'springbok-memory/v1' || m.metric !== 'memory' || m.scope !== 'linux-proc-meminfo' || m.unit !== 'bytes') throw new Error('memory unconfirmed');
    if (m.status === 'unavailable') {
      if (!['read-failed', 'invalid-meminfo', 'memavailable-missing', 'clock-unavailable'].includes(m.reason) || !['sampledAt', 'totalBytes', 'availableBytes', 'usedBytes', 'usagePercent'].every(key => m[key] === null)) throw new Error('memory null unconfirmed');
      return [`内存：采集不可用；${state}；${m.reason}`, '内存采样时间 无；数值未知。'];
    }
    if (m.status !== 'available' || m.reason !== null || !iso(m.sampledAt) || !['totalBytes', 'availableBytes', 'usedBytes'].every(key => integer(m[key])) || m.totalBytes === 0 || m.availableBytes > m.totalBytes || m.usedBytes !== m.totalBytes - m.availableBytes || m.usagePercent !== Number((BigInt(m.usedBytes) * 10000n + BigInt(m.totalBytes) / 2n) / BigInt(m.totalBytes)) / 100) throw new Error('memory value unconfirmed');
    const size = bytes => `${(bytes / 1073741824).toFixed(2)} GiB（${bytes} bytes）`;
    return [`内存：${m.usagePercent.toFixed(2)}%；${state}；已用 ${size(m.usedBytes)}；可用 ${size(m.availableBytes)}；总量 ${size(m.totalBytes)}`, `内存采样时间 ${m.sampledAt}；范围 linux-proc-meminfo。`];
  } catch { return ['内存未确认：当前值未知。']; }
}
function diskLines(sample, state) {
  if (!Object.hasOwn(sample, 'disk') && ((!Object.hasOwn(sample, 'sampleVersion') && !Object.hasOwn(sample, 'memory')) || sample.sampleVersion === 2)) return ['磁盘未上报：旧客户端样本。'];
  try {
    if (![3, 4].includes(sample.sampleVersion)) throw new Error('disk version unconfirmed');
    const disk = diskSample(sample.disk, sample.sampleVersion === 4 ? V4_DISK_REPORT_BYTES : undefined);
    if (disk.reason === 'report-too-large') return [`磁盘未上报：完整挂载点结果超过 ${sample.sampleVersion === 4 ? 3 : 6} KiB 上报预算`];
    const lines = [`磁盘：${disk.status === 'available' ? '采集可用' : disk.status === 'partial' ? '部分采集不可用' : '采集不可用'}；${state}${disk.reason ? `；${disk.reason}` : ''}`, `磁盘采样时间 ${disk.sampledAt ?? '无'}；范围 linux-mount-namespace。`];
    const size = bytes => `${(bytes / 1073741824).toFixed(2)} GiB（${bytes} bytes）`;
    for (const mount of disk.mounts) {
      lines.push(`挂载点 ${mount.mountPoint}；${mount.fsType}；${mount.readOnly ? '只读' : '可写'}；${mount.status === 'available' ? `${mount.usagePercent.toFixed(2)}%；已用 ${size(mount.usedBytes)}；普通用户可用 ${size(mount.availableBytes)}；总量 ${size(mount.totalBytes)}；free 与 available 差额 ${size(mount.reservedBytes)}` : `采集不可用；${mount.reason}；数值未知`}；${state}`);
    }
    if (disk.filtered) lines.push(`已过滤：伪文件系统 ${disk.filtered.pseudo}、不支持 ${disk.filtered.unsupported}、子树 ${disk.filtered.subtree}、拓扑不确定 ${disk.filtered.unsafeTopology}`);
    return lines;
  } catch { return ['磁盘未确认：当前值未知。']; }
}
function networkLines(sample, state) {
  if (!Object.hasOwn(sample, 'network') && ((!Object.hasOwn(sample, 'sampleVersion') && !Object.hasOwn(sample, 'memory') && !Object.hasOwn(sample, 'disk')) || [2, 3].includes(sample.sampleVersion))) return ['网络未上报：旧客户端样本。'];
  try {
    if (sample.sampleVersion !== 4) throw new Error('network version unconfirmed');
    const network = networkSample(sample.network);
    if (network.reason === 'report-too-large') return ['网络未上报：完整接口结果超过 3 KiB 上报预算'];
    const reading = network.status === 'available' ? '采集可用' : network.status === 'partial' ? '部分采集未知' : network.status === 'unknown' ? '采集未知' : '采集不可用';
    const lines = [`网络：${reading}；${state}${network.reason ? `；${network.reason}` : ''}`, `网络采样时间 ${network.sampledAt ?? '无'}；实际窗口 ${network.intervalMs ?? '未知'} ms；范围 linux-network-namespace。`];
    for (const row of network.interfaces) lines.push(`接口 ${row.name}；${row.status === 'available' ? `接收 ${row.rxBytesPerSecond.toFixed(2)} bytes/s；发送 ${row.txBytesPerSecond.toFixed(2)} bytes/s；窗口接收 ${row.rxBytes} bytes；窗口发送 ${row.txBytes} bytes` : `采集未知；${row.reason}；数值未知`}；${state}`);
    if (network.status === 'unavailable') lines.push('网络数值未知。');
    return lines;
  } catch { return ['网络未确认：当前值未知。']; }
}
export function clearTelemetry() {
  generation++; controller?.abort(); controller = null;
  for (const timer of timers) clearTimeout(timer); timers.clear();
}
export function telemetryView(server, parent, session) {
  if (!['enrolling', 'active'].includes(server.state)) return;
  const panel = document.createElement('div'); panel.dataset.telemetry = server.id; parent.append(panel);
  if (!session?.telemetryEnabled) { panel.textContent = 'CPU/内存/磁盘/网络上报功能未启用。'; return; }
  panel.textContent = '读取 CPU/内存/磁盘/网络最新快照…';
  const version = generation, ownerId = session.ownerId, requestedAt = performance.now();
  controller ??= new AbortController();
  void (async () => {
    try {
      const response = await fetch(`/api/admin/nodes/${server.id}/telemetry`, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('telemetry unconfirmed');
      const value = await response.json();
      if (version !== generation || !panel.isConnected) return;
      if (value.protocolVersion !== 2 || value.mode !== 'node-telemetry-only' || value.ownerId !== ownerId || value.nodeId !== server.id || value.executionReady !== false || !Number.isSafeInteger(value.evaluatedAt) || value.evaluatedAt < 0 || value.thresholds?.intervalMs !== 30000 || value.thresholds?.staleMs !== 90000 || !['fresh', 'stale', 'unknown'].includes(value.freshness)) throw new Error('telemetry scope unconfirmed');
      let validMs = 30000;
      if (value.sample === null) {
        if (value.freshness !== 'unknown') throw new Error('telemetry sample unconfirmed');
        panel.textContent = 'CPU/内存/磁盘/网络未知：尚无已确认采样或节点尚未完成加入。';
      } else {
        const { receivedAt } = value.sample;
        if (!integer(receivedAt)) throw new Error('telemetry sample unconfirmed');
        const age = value.evaluatedAt - receivedAt;
        if (value.freshness !== (age < 0 ? 'unknown' : age >= 90000 ? 'stale' : 'fresh')) throw new Error('telemetry freshness unconfirmed');
        const state = value.freshness === 'stale' ? '陈旧' : value.freshness === 'unknown' ? '新鲜度未知' : '最近已接收';
        panel.replaceChildren();
        for (const text of [...cpuLines(value.sample.cpu, state), ...memoryLines(value.sample, state), ...diskLines(value.sample, state), ...networkLines(value.sample, state), `云端接收时间 ${new Date(receivedAt).toISOString()}`]) { const p = document.createElement('p'); p.textContent = text; panel.append(p); }
        if (value.freshness === 'fresh') validMs = Math.min(validMs, Math.max(0, 90000 - age));
      }
      validMs = Math.max(0, validMs - (performance.now() - requestedAt));
      const expiry = performance.now() + validMs;
      const expire = () => { if (version === generation && panel.isConnected && performance.now() >= expiry) panel.textContent = 'CPU/内存/磁盘/网络快照已过期：当前值未知，请刷新目录重新查询。'; };
      const timer = setTimeout(() => { timers.delete(timer); expire(); }, validMs); timers.add(timer); panel._expireTelemetry = expire;
      expire(); // 请求耗时已超过有效期时不短暂展示新鲜值。
    } catch { if (version === generation && panel.isConnected) panel.textContent = 'CPU/内存/磁盘/网络未确认：当前值未知。目录和心跳仍保留，请刷新核对。'; }
  })();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const panel of document.querySelectorAll('[data-telemetry]')) panel._expireTelemetry?.(); });
