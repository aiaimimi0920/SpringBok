const $ = id => document.getElementById(id);
let session, snapshot, preview, generation = 0, busy = false, timer;
const labels = { dispatching: '提交执行中，禁止重发', dispatched: '已发出执行请求', 'dispatch-unknown': '提交响应未知，禁止重发',
  running: '执行许可已消费，等待回执', succeeded: '应用报告检查通过', 'deployed-unverified': '已部署但业务未验证', failed: '应用报告失败', unknown: '结果未知，禁止重放' };
const notice = text => { $('sba-notice').textContent = text; };
function closePreview() { clearTimeout(timer); preview = null; $('sba-submit').disabled = true; if ($('sba-confirm').open) $('sba-confirm').close(); }
export function clearSba() {
  generation++; session = null; snapshot = null; closePreview();
  $('sba-panel').hidden = true; $('sba-record').textContent = ''; $('sba-plan').textContent = '';
  $('sba-start').disabled = true; $('sba-reconcile').disabled = true;
}
async function request(path, body) {
  const csrf = session?.csrf ?? '';
  const response = await fetch(`/api/admin/sba/${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error',
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('请求未确认；请刷新身份与持久记录，不要重复部署');
  return response.json();
}
function render() {
  $('sba-start').disabled = busy || !snapshot?.ready;
  $('sba-reconcile').disabled = busy || snapshot?.job?.status !== 'running';
  $('sba-record').textContent = snapshot?.job ? `${labels[snapshot.job.status] ?? '未知状态'}\n${JSON.stringify(snapshot.job, null, 2)}` : '尚无首次部署任务';
  if (snapshot?.history?.length) $('sba-record').textContent += `\n已核实未执行的历史（保留，不重放）：\n${JSON.stringify(snapshot.history, null, 2)}`;
}
export async function refreshSba(value) {
  clearSba(); if (!value?.sbaEnabled) return;
  session = value; $('sba-panel').hidden = false; const version = generation;
  notice('读取 SBA 持久记录…');
  try { const next = await request('state'); if (version !== generation) return; snapshot = next; render(); notice('已读取持久记录，没有触发部署或自动回收'); }
  catch (error) { if (version === generation) notice(error.message); }
}
$('sba-start').addEventListener('click', async () => {
  if (busy || !snapshot?.ready || !session) return;
  closePreview(); busy = true; const version = ++generation; render();
  try {
    const value = await request('preview', { taskId: `sba-${crypto.randomUUID()}` }); if (version !== generation) return;
    preview = value; $('sba-plan').textContent = JSON.stringify(value.plan.request, null, 2);
    $('sba-submit').disabled = false; $('sba-confirm').showModal(); notice('请核对固定源码 SHA、环境和公开配置；取消不会部署');
    timer = setTimeout(() => { closePreview(); notice('确认已过期，请重新预览'); }, Math.max(0, value.expiresAt - Date.now()));
  } catch (error) { if (version === generation) notice(error.message); }
  finally { busy = false; if (version === generation) render(); }
});
function cancel() { if (busy) return; generation++; closePreview(); notice('已取消，没有提交部署'); }
$('sba-cancel').addEventListener('click', cancel);
$('sba-confirm').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('sba-submit').addEventListener('click', async () => {
  if (!preview || busy || !session) return;
  const value = preview, version = generation; busy = true; closePreview(); snapshot = null; render();
  try { const next = await request('submit', value); if (version === generation) { snapshot = next; notice('提交已记录；读取状态不会重新执行'); } }
  catch (error) { if (version === generation) notice(error.message); }
  finally { busy = false; if (version === generation) render(); }
});
$('sba-reconcile').addEventListener('click', async () => {
  if (busy || snapshot?.job?.status !== 'running') return;
  const version = generation, taskId = snapshot.job.request.taskId; busy = true; render();
  try { const next = await request('reconcile', { taskId }); if (version === generation) { snapshot = next; notice('已核对 GitHub run 和可信回执，没有重新部署'); } }
  catch (error) { if (version === generation) notice(error.message); }
  finally { busy = false; if (version === generation) render(); }
});
addEventListener('popstate', cancel);
