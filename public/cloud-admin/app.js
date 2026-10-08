import { clearSba, refreshSba } from './sba.js';
import { clearCatalog, refreshCatalog } from './catalog.js';
const $ = id => document.getElementById(id);
let state, preview, generation = 0, controller, timer, sending = false;
const labels = { queued: '等待节点领取', claimed: '节点已领取，等待回执', unknown: '结果未知，执行已阻断', expired: '任务过期', observed: '仅协议观察通过', 'fixture-verified': '固定测试四阶段回执齐备' };
function invalidate() { clearTimeout(timer); generation++; controller?.abort(); controller = null; preview = null; $('submit').disabled = true; if ($('confirm').open) $('confirm').close(); }
function status(text) { $('notice').textContent = text; }
async function request(path, body, signal) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal,
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': state?.csrf ?? '' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('身份、计划或记录已变化；请刷新。若登录已过期，请重新通过访问验证');
  return response.json();
}
function render() {
  $('identity').textContent = `已验证管理员：${state.email}`;
  $('start').disabled = !state.ready || sending;
  $('readiness').textContent = state.ready ? '固定测试可执行' : '固定测试不可执行';
  $('jobs').replaceChildren();
  for (const job of [...state.jobs].reverse()) {
    const item = document.createElement('li'), title = document.createElement('strong'); title.textContent = `${job.input.id} · ${labels[job.status] ?? '未知状态'}`; item.append(title);
    const info = document.createElement('p'); info.textContent = `操作：${job.input.operation}；绑定：${job.input.challenge}`; item.append(info);
    const audit = state.audit.find(a => a.id === job.input.id); if (audit) { const p = document.createElement('p'); p.textContent = `已验证操作者标识：${audit.actor}`; item.append(p); }
    if (job.receipt?.evidence) {
      const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '查看四阶段实际节点回执'; details.append(summary);
      for (const row of job.receipt.evidence.stages) { const p = document.createElement('p'); p.textContent = `${row.stage}：${row.health}；Update ${row.updateId}；容器 ${row.containerId}；镜像 ${row.image}；配置 ${row.configDigest}；卷标记 ${row.marker ?? '预期失败阶段不读取'}`; details.append(p); } item.append(details);
    }
    $('jobs').append(item);
  }
  if (!state.jobs.length) { const item = document.createElement('li'); item.textContent = '尚无持久任务'; $('jobs').append(item); }
}
async function refresh() {
  if (sending) return;
  invalidate(); clearCatalog(); clearSba(); state = null; $('identity').textContent = '重新验证管理员身份…'; $('jobs').replaceChildren(); $('readiness').textContent = '未取得服务端状态'; $('start').disabled = true; const version = generation; controller = new AbortController(); status('读取记录…');
  try { const value = await request('/api/admin/state', null, controller.signal); if (version !== generation) return; state = value; render(); status('记录已刷新'); void refreshCatalog(value); void refreshSba(value); }
  catch (error) { if (version === generation) status(error.message); }
}
$('refresh').addEventListener('click', refresh);
$('start').addEventListener('click', async () => {
  if (!state?.ready || sending) return; invalidate(); const version = generation; controller = new AbortController(); $('start').disabled = true; status('读取当前绑定计划…');
  try {
    const value = await request('/api/admin/preview', { id: crypto.randomUUID(), revision: state.revision }, controller.signal); if (version !== generation) return;
    preview = value; $('plan').replaceChildren();
    for (const [label, text] of [['请求ID', value.input.id], ['节点', value.input.node], ['顺序', 'v1 → v2 → bad → 回滚v1'], ['绑定摘要', value.input.challenge], ['记录版本', String(value.input.revision)], ['确认截止', new Date(value.expiresAt).toLocaleTimeString()]]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = text; $('plan').append(dt, dd); }
    $('submit').disabled = false; timer = setTimeout(() => { cancel(); status('确认已过期，请重新读取计划'); }, Math.max(0, value.expiresAt - Date.now())); $('confirm').showModal(); status('请核对测试计划');
  } catch (error) { if (version === generation) status(error.message); }
  finally { if (version === generation) $('start').disabled = !state?.ready; }
});
function cancel() { if (sending) return; invalidate(); $('start').disabled = !state?.ready; status('已取消'); }
$('cancel').addEventListener('click', cancel); $('confirm').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('submit').addEventListener('click', async () => {
  if (!preview || sending) return; const value = preview; preview = null; sending = true; $('submit').disabled = true; $('cancel').disabled = true; $('start').disabled = true; $('refresh').disabled = true;
  try { await request('/api/admin/submit', value); status(`已提交 ${value.input.id}；请刷新查看节点回执`); }
  catch { status(`提交 ${value.input.id} 的结果未确认；刷新记录前不要重新提交`); }
  finally { sending = false; $('cancel').disabled = false; $('refresh').disabled = false; invalidate(); clearCatalog(); clearSba(); state = null; $('identity').textContent = '重新验证管理员身份…'; $('jobs').replaceChildren(); $('readiness').textContent = '未取得服务端状态'; $('start').disabled = true; }
});
addEventListener('pagehide', () => { invalidate(); clearCatalog(); clearSba(); state = null; $('identity').textContent = '需要重新验证身份'; $('jobs').replaceChildren(); $('start').disabled = true; });
addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
addEventListener('popstate', () => { cancel(); });
void refresh();
