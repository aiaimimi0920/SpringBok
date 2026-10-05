import { clearEnrollment, configureEnrollment, enrollmentAction } from './enrollment.js';
import { clearTelemetry, telemetryView } from './telemetry.js';
const $ = id => document.getElementById(id);
const uncertain = '目录未确认：可能身份已过期、记录已变化、达到容量上限或网络中断。请刷新目录核对，不要重复创建。';
let catalog, csrf, catalogSession, generation = 0, controller, busy = false;
let heartbeatController, heartbeatGeneration = 0;
const heartbeatTimers = new Set();
function clearHeartbeats() {
  heartbeatGeneration++; heartbeatController?.abort(); heartbeatController = null;
  for (const timer of heartbeatTimers) clearTimeout(timer); heartbeatTimers.clear();
}
export function clearCatalog() {
  clearEnrollment();
  clearHeartbeats();
  clearTelemetry();
  generation++; controller?.abort(); controller = null; catalog = null; csrf = null; catalogSession = null; busy = false;
  $('catalog').hidden = true; $('servers').replaceChildren(); $('server-name').value = ''; $('server-add').disabled = true;
  $('services').replaceChildren(); $('service-server').replaceChildren(); $('service-name').value = ''; $('service-add').disabled = true;
}
function heartbeatView(server, parent) {
  if (!['enrolling', 'active'].includes(server.state)) return;
  const panel = document.createElement('div'); panel.dataset.heartbeat = server.id; parent.append(panel);
  if (!catalogSession?.heartbeatEnabled) { panel.textContent = '心跳功能未启用（不代表节点离线）。'; return; }
  panel.textContent = '读取执行/采集角色心跳…';
  const version = heartbeatGeneration, ownerId = catalogSession.ownerId;
  const requestedAt = performance.now();
  heartbeatController ??= new AbortController();
  void (async () => {
    try {
      const response = await fetch(`/api/admin/nodes/${server.id}/heartbeat`, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([heartbeatController.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('heartbeat unconfirmed');
      const value = await response.json();
      if (version !== heartbeatGeneration || !panel.isConnected) return;
      if (value.ownerId !== ownerId || value.nodeId !== server.id || value.executionReady !== false || value.mode !== 'node-heartbeat-only' || !Number.isSafeInteger(value.evaluatedAt)) throw new Error('heartbeat scope unconfirmed');
      const labels = { online: '在线', stale: '陈旧', offline: '离线', unknown: '未知/尚无心跳' };
      panel.replaceChildren(); let validMs = 30000;
      for (const [role, name] of [['execute', '执行角色'], ['observe', '采集角色']]) {
        const entry = value.roles?.[role];
        if (!entry || !Object.hasOwn(labels, entry.status)) throw new Error('heartbeat state unconfirmed');
        const p = document.createElement('p'); p.dataset.heartbeatRole = role;
        p.textContent = `${name}：${labels[entry.status]}；采样时间 ${entry.sample ? new Date(entry.sample.sampledAt).toISOString() : '无'}；云端接收时间 ${entry.sample ? new Date(entry.sample.receivedAt).toISOString() : '无'}`;
        panel.append(p);
        if (entry.status === 'online' || entry.status === 'stale') {
          const boundary = entry.status === 'online' ? value.thresholds.staleMs : value.thresholds.offlineMs;
          validMs = Math.min(validMs, Math.max(0, boundary - (value.evaluatedAt - entry.sample.receivedAt)));
        }
      }
      const note = document.createElement('p');
      note.textContent = `云端判定于 ${new Date(value.evaluatedAt).toISOString()}；自云端接收起 ${value.thresholds.staleMs / 1000} 秒陈旧、${value.thresholds.offlineMs / 1000} 秒离线。心跳不证明业务健康或部署就绪。`;
      panel.append(note);
      validMs = Math.max(0, validMs - (performance.now() - requestedAt));
      const expiry = performance.now() + validMs;
      const expire = () => { if (version === heartbeatGeneration && panel.isConnected && performance.now() >= expiry) panel.textContent = '心跳快照已过期：当前状态未知，请刷新目录重新取得云端判定。'; };
      const timer = setTimeout(() => { heartbeatTimers.delete(timer); expire(); }, validMs);
      heartbeatTimers.add(timer);
      // 后台标签页恢复时不保留已过期的“在线”；身份切换由同一清理边界中止。
      panel._expireHeartbeat = expire;
    } catch { if (version === heartbeatGeneration && panel.isConnected) panel.textContent = '心跳未确认：当前状态未知（不是已确认离线）。目录记录仍保留，请刷新核对。'; }
  })();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const panel of document.querySelectorAll('[data-heartbeat]')) panel._expireHeartbeat?.(); });
async function call(body, signal, resource = 'servers') {
  const response = await fetch(`/api/admin/${resource}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal,
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(uncertain);
  return response.json();
}
async function readCatalog(signal) {
  const [servers, services] = await Promise.all([call(null, signal), call(null, signal, 'services')]);
  // 两次读取不是跨请求事务；版本不一致时不能用拼接快照继续修改。
  if (servers.revision !== services.revision || servers.executionReady !== false || services.executionReady !== false) throw new Error(uncertain);
  return { ...servers, services: services.services };
}
function render() {
  clearHeartbeats();
  clearTelemetry();
  $('servers').replaceChildren(); $('server-add').disabled = busy || !catalog; $('server-name').disabled = busy || !catalog; $('catalog-refresh').disabled = busy;
  for (const server of catalog?.servers ?? []) {
    const item = document.createElement('li'); item.dataset.serverId = server.id;
    const title = document.createElement('strong'); title.textContent = server.name; item.append(title);
    const labels = { draft: '尚未接入服务器', enrolling: '加入中或待核对（不代表在线）', active: '已完成加入登记（不代表在线或部署就绪）', archived: '已归档（没有卸载或删除数据）' };
    const info = document.createElement('p'); info.textContent = `${server.id} · ${labels[server.state] ?? '未知状态，禁止操作'}`; item.append(info);
    heartbeatView(server, item);
    telemetryView(server, item, catalogSession);
    if (server.state === 'draft') {
      const actions = document.createElement('div'); actions.className = 'actions server-actions';
      const name = document.createElement('input'); name.value = server.name; name.maxLength = 128; name.setAttribute('aria-label', `服务器名称 ${server.id}`); name.disabled = busy;
      const rename = document.createElement('button'); rename.textContent = '保存名称'; rename.disabled = busy; rename.addEventListener('click', () => mutate({ action: 'rename', serverId: server.id, name: name.value }));
      const linked = catalog.services.some(service => service.serverId === server.id && service.state === 'draft');
      const archive = document.createElement('button'); archive.textContent = '归档条目'; archive.disabled = busy || linked; archive.title = linked ? '先归档关联服务条目；不会停止或卸载服务' : ''; archive.addEventListener('click', () => mutate({ action: 'archive', serverId: server.id }));
      if (linked) { const note = document.createElement('p'); note.textContent = '有关联的未归档服务，暂不能归档此服务器条目。'; item.append(note); }
      actions.append(name, rename, archive); item.append(actions);
    }
    const enrollment = enrollmentAction(server, catalog.revision); if (enrollment) item.append(enrollment);
    $('servers').append(item);
  }
  if (catalog && !catalog.servers.length) { const empty = document.createElement('li'); empty.textContent = '尚无服务器目录条目'; $('servers').append(empty); }
  const selected = $('service-server').value;
  $('service-server').replaceChildren();
  for (const server of catalog?.servers ?? []) {
    if (!['draft', 'enrolling', 'active'].includes(server.state)) continue;
    const option = document.createElement('option'); option.value = server.id; option.textContent = `${server.name} · ${server.id}`; $('service-server').append(option);
  }
  if ([...$('service-server').options].some(option => option.value === selected)) $('service-server').value = selected;
  const unavailable = busy || !catalog || !$('service-server').options.length;
  $('service-server').disabled = unavailable; $('service-name').disabled = unavailable; $('service-add').disabled = unavailable;
  $('services').replaceChildren();
  for (const service of catalog?.services ?? []) {
    const item = document.createElement('li'); item.dataset.serviceId = service.id;
    const title = document.createElement('strong'); title.textContent = service.name; item.append(title);
    const info = document.createElement('p'); info.textContent = `${service.id} · 服务器 ${service.serverId} · ${service.state === 'draft' ? '仅登记，尚未部署' : '已归档（没有停止、卸载或删除数据）'}`; item.append(info);
    if (service.state === 'draft') {
      const actions = document.createElement('div'); actions.className = 'actions server-actions';
      const name = document.createElement('input'); name.value = service.name; name.maxLength = 128; name.setAttribute('aria-label', `服务名称 ${service.id}`); name.disabled = busy;
      const rename = document.createElement('button'); rename.textContent = '保存服务名称'; rename.disabled = busy; rename.addEventListener('click', () => mutate({ action: 'rename', serviceId: service.id, name: name.value }, 'services'));
      const archive = document.createElement('button'); archive.textContent = '归档服务条目'; archive.disabled = busy; archive.addEventListener('click', () => mutate({ action: 'archive', serviceId: service.id }, 'services'));
      actions.append(name, rename, archive); item.append(actions);
    }
    $('services').append(item);
  }
  if (catalog && !catalog.services.length) { const empty = document.createElement('li'); empty.textContent = '尚无服务目录条目'; $('services').append(empty); }
}
export async function refreshCatalog(session) {
  clearCatalog(); if (!session.catalogEnabled) return;
  catalogSession = session;
  configureEnrollment(session, () => refreshCatalog(session));
  csrf = session.csrf; $('catalog').hidden = false; $('catalog-notice').textContent = '读取服务器目录…'; render();
  const version = generation; controller = new AbortController();
  try { const next = await readCatalog(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])); if (version !== generation) return; catalog = next; render(); $('catalog-notice').textContent = `目录版本 ${catalog.revision}；这里仅登记元数据，不连接或部署服务器。`; }
  catch { if (version === generation) { catalog = null; render(); $('catalog-notice').textContent = uncertain; } }
}
async function mutate(change, resource = 'servers') {
  if (busy || !catalog) return;
  const input = { id: crypto.randomUUID(), revision: catalog.revision, ...change }, version = generation;
  busy = true; render(); $('catalog-notice').textContent = '保存目录变更…';
  try {
    await call(input, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), resource);
    if (version !== generation) return;
    const next = await readCatalog(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
    if (version !== generation) return;
    catalog = next; if (change.action === 'create') $(resource === 'servers' ? 'server-name' : 'service-name').value = '';
    $('catalog-notice').textContent = `目录已保存（版本 ${catalog.revision}），没有连接服务器或触发部署。`;
  } catch { if (version === generation) { catalog = null; $('catalog-notice').textContent = `${uncertain} 请求 ${input.id}`; } }
  finally { if (version === generation) { busy = false; render(); } }
}
$('server-form').addEventListener('submit', event => { event.preventDefault(); void mutate({ action: 'create', name: $('server-name').value }); });
$('service-form').addEventListener('submit', event => { event.preventDefault(); void mutate({ action: 'create', serverId: $('service-server').value, name: $('service-name').value }, 'services'); });
$('catalog-refresh').addEventListener('click', () => { if (!busy && catalogSession) void refreshCatalog(catalogSession); });
