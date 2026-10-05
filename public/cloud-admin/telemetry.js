let generation = 0, controller;
const timers = new Set();
export function clearTelemetry() {
  generation++; controller?.abort(); controller = null;
  for (const timer of timers) clearTimeout(timer); timers.clear();
}
export function telemetryView(server, parent, session) {
  if (!['enrolling', 'active'].includes(server.state)) return;
  const panel = document.createElement('div'); panel.dataset.telemetry = server.id; parent.append(panel);
  if (!session?.telemetryEnabled) { panel.textContent = 'CPU 上报功能未启用（不代表 CPU 为 0）。'; return; }
  panel.textContent = '读取 CPU 最新快照…';
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
        panel.textContent = 'CPU 未知：尚无已确认采样或节点尚未完成加入。';
      } else {
        const { cpu, receivedAt } = value.sample;
        if (!Number.isSafeInteger(receivedAt) || receivedAt < 0 || cpu?.schema !== 'springbok-cpu/v1' || cpu.metric !== 'cpu' || cpu.scope !== 'linux-proc-stat' || cpu.unit !== 'percent' || !['available', 'unknown', 'unavailable'].includes(cpu.status)) throw new Error('telemetry sample unconfirmed');
        const age = value.evaluatedAt - receivedAt;
        if (value.freshness !== (age < 0 ? 'unknown' : age >= 90000 ? 'stale' : 'fresh')) throw new Error('telemetry freshness unconfirmed');
        if (cpu.status === 'available' ? !Number.isFinite(cpu.usagePercent) || cpu.usagePercent < 0 || cpu.usagePercent > 100 || !Number.isSafeInteger(cpu.intervalMs) || cpu.intervalMs < 30000 || cpu.reason !== null : cpu.usagePercent !== null || cpu.intervalMs !== null) throw new Error('telemetry value unconfirmed');
        if (cpu.status === 'unavailable' ? cpu.sampledAt !== null || cpu.logicalCpuCount !== null || !['read-failed', 'invalid-counters', 'clock-unavailable'].includes(cpu.reason) : typeof cpu.sampledAt !== 'string' || !Number.isFinite(Date.parse(cpu.sampledAt)) || new Date(cpu.sampledAt).toISOString() !== cpu.sampledAt || !Number.isSafeInteger(cpu.logicalCpuCount) || cpu.logicalCpuCount < 1 || cpu.logicalCpuCount > 8192 || (cpu.status === 'unknown' && !['warming-up', 'clock-regressed', 'interval-too-short', 'cpu-set-changed', 'counter-regressed', 'no-counter-progress'].includes(cpu.reason))) throw new Error('telemetry collection unconfirmed');
        const state = value.freshness === 'stale' ? '陈旧（不是当前 CPU）' : value.freshness === 'unknown' ? '新鲜度未知' : '最近已接收（不证明业务健康）';
        const reading = cpu.status === 'available' ? `${cpu.usagePercent.toFixed(2)}%` : cpu.status === 'unavailable' ? '采集不可用' : '采集未知';
        panel.replaceChildren();
        for (const text of [`CPU：${reading}；${state}${cpu.reason ? `；${cpu.reason}` : ''}`, `采样时间 ${cpu.sampledAt ?? '无'}；云端接收时间 ${new Date(receivedAt).toISOString()}`, `范围 linux-proc-stat（未证明宿主位置）；逻辑 CPU ${cpu.logicalCpuCount ?? '未知'}；实际窗口 ${cpu.intervalMs ?? '未知'} ms。云端接收 90 秒后陈旧。`]) { const p = document.createElement('p'); p.textContent = text; panel.append(p); }
        if (value.freshness === 'fresh') validMs = Math.min(validMs, Math.max(0, 90000 - age));
      }
      validMs = Math.max(0, validMs - (performance.now() - requestedAt));
      const expiry = performance.now() + validMs;
      const expire = () => { if (version === generation && panel.isConnected && performance.now() >= expiry) panel.textContent = 'CPU 快照已过期：当前值未知，请刷新目录重新查询。'; };
      const timer = setTimeout(() => { timers.delete(timer); expire(); }, validMs); timers.add(timer); panel._expireTelemetry = expire;
      expire(); // 请求耗时已超过有效期时不短暂展示新鲜值。
    } catch { if (version === generation && panel.isConnected) panel.textContent = 'CPU 未确认：当前值未知（不是 0，也不是已确认陈旧）。目录和心跳仍保留，请刷新核对。'; }
  })();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const panel of document.querySelectorAll('[data-telemetry]')) panel._expireTelemetry?.(); });
