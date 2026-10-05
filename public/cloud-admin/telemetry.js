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
    return [`CPU：${reading}；${state}${cpu.reason ? `；${cpu.reason}` : ''}`, `CPU 采样时间 ${cpu.sampledAt ?? '无'}；范围 linux-proc-stat（未证明宿主位置）；逻辑 CPU ${cpu.logicalCpuCount ?? '未知'}；实际窗口 ${cpu.intervalMs ?? '未知'} ms。`];
  } catch { return ['CPU 未确认：当前值未知（不是 0）。']; }
}
function memoryLines(sample, state) {
  if (!Object.hasOwn(sample, 'sampleVersion') && !Object.hasOwn(sample, 'memory')) return ['内存未上报：旧 CPU-only 样本，不代表内存为 0 或采集失败。'];
  try {
    const m = sample.memory;
    if (sample.sampleVersion !== 2 || !exact(m, ['schema', 'metric', 'scope', 'unit', 'status', 'reason', 'sampledAt', 'totalBytes', 'availableBytes', 'usedBytes', 'usagePercent']) || m.schema !== 'springbok-memory/v1' || m.metric !== 'memory' || m.scope !== 'linux-proc-meminfo' || m.unit !== 'bytes') throw new Error('memory unconfirmed');
    if (m.status === 'unavailable') {
      if (!['read-failed', 'invalid-meminfo', 'memavailable-missing', 'clock-unavailable'].includes(m.reason) || !['sampledAt', 'totalBytes', 'availableBytes', 'usedBytes', 'usagePercent'].every(key => m[key] === null)) throw new Error('memory null unconfirmed');
      return [`内存：采集不可用；${state}；${m.reason}`, '内存采样时间 无；数值未知（不是 0）。'];
    }
    if (m.status !== 'available' || m.reason !== null || !iso(m.sampledAt) || !['totalBytes', 'availableBytes', 'usedBytes'].every(key => integer(m[key])) || m.totalBytes === 0 || m.availableBytes > m.totalBytes || m.usedBytes !== m.totalBytes - m.availableBytes || m.usagePercent !== Number((BigInt(m.usedBytes) * 10000n + BigInt(m.totalBytes) / 2n) / BigInt(m.totalBytes)) / 100) throw new Error('memory value unconfirmed');
    const size = bytes => `${(bytes / 1073741824).toFixed(2)} GiB（${bytes} bytes）`;
    return [`内存：${m.usagePercent.toFixed(2)}%；${state}；已用 ${size(m.usedBytes)}；可用 ${size(m.availableBytes)}；总量 ${size(m.totalBytes)}`, `内存采样时间 ${m.sampledAt}；范围 linux-proc-meminfo（未证明宿主位置，不代表容器可分配限额）。`];
  } catch { return ['内存未确认：当前值未知（不是 0，也不是旧样本未上报）。']; }
}
export function clearTelemetry() {
  generation++; controller?.abort(); controller = null;
  for (const timer of timers) clearTimeout(timer); timers.clear();
}
export function telemetryView(server, parent, session) {
  if (!['enrolling', 'active'].includes(server.state)) return;
  const panel = document.createElement('div'); panel.dataset.telemetry = server.id; parent.append(panel);
  if (!session?.telemetryEnabled) { panel.textContent = 'CPU/内存上报功能未启用（不代表用量为 0）。'; return; }
  panel.textContent = '读取 CPU/内存最新快照…';
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
        panel.textContent = 'CPU/内存未知：尚无已确认采样或节点尚未完成加入。';
      } else {
        const { receivedAt } = value.sample;
        if (!integer(receivedAt)) throw new Error('telemetry sample unconfirmed');
        const age = value.evaluatedAt - receivedAt;
        if (value.freshness !== (age < 0 ? 'unknown' : age >= 90000 ? 'stale' : 'fresh')) throw new Error('telemetry freshness unconfirmed');
        const state = value.freshness === 'stale' ? '陈旧（不是当前值）' : value.freshness === 'unknown' ? '新鲜度未知' : '最近已接收（不证明业务健康）';
        panel.replaceChildren();
        for (const text of [...cpuLines(value.sample.cpu, state), ...memoryLines(value.sample, state), `云端接收时间 ${new Date(receivedAt).toISOString()}；云端接收 90 秒后陈旧。`]) { const p = document.createElement('p'); p.textContent = text; panel.append(p); }
        if (value.freshness === 'fresh') validMs = Math.min(validMs, Math.max(0, 90000 - age));
      }
      validMs = Math.max(0, validMs - (performance.now() - requestedAt));
      const expiry = performance.now() + validMs;
      const expire = () => { if (version === generation && panel.isConnected && performance.now() >= expiry) panel.textContent = 'CPU/内存快照已过期：当前值未知，请刷新目录重新查询。'; };
      const timer = setTimeout(() => { timers.delete(timer); expire(); }, validMs); timers.add(timer); panel._expireTelemetry = expire;
      expire(); // 请求耗时已超过有效期时不短暂展示新鲜值。
    } catch { if (version === generation && panel.isConnected) panel.textContent = 'CPU/内存未确认：当前值未知（不是 0，也不是已确认陈旧）。目录和心跳仍保留，请刷新核对。'; }
  })();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const panel of document.querySelectorAll('[data-telemetry]')) panel._expireTelemetry?.(); });
