const $ = id => document.getElementById(id);
let session, reload, pending, busy = false, generation = 0, controller;
const notice = text => { $('enrollment-notice').textContent = text; };
export function clearEnrollment() {
  generation++; controller?.abort(); controller = null; session = null; pending = null; busy = false;
  $('enrollment-dialog').close(); $('enrollment-panel').hidden = true;
  $('enrollment-confirm-saved').checked = false; $('enrollment-authorize').disabled = true;
  $('enrollment-cancel').disabled = false; $('enrollment-finish').disabled = false;
  $('enrollment-finish').hidden = true; notice('');
}
export function configureEnrollment(value, refresh) {
  clearEnrollment(); reload = refresh;
  if (!value.enrollmentEnabled) return;
  session = { ownerId: value.ownerId, csrf: value.csrf }; $('enrollment-panel').hidden = false;
}
async function call(path, body, signal) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal,
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': session.csrf } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('加入结果未确认；请用已保存材料核对，不要生成新秘密或重复创建');
  return response.json();
}
function randomSecret() { return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function begin(server, revision) {
  if (busy || !session) return;
  busy = true;
  const version = generation, seed = { protocolVersion: 2, origin: location.origin, ownerId: session.ownerId, nodeId: server.id, enrollmentId: crypto.randomUUID(), challenge: randomSecret() };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['springbok-join/v2', seed.ownerId, seed.nodeId, seed.enrollmentId, seed.challenge])));
  if (version !== generation) return;
  busy = false;
  pending = { seed, revision, challengeDigest: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''), downloaded: false, uncertain: false };
  $('enrollment-target').textContent = `${server.name} · ${server.id}`;
  $('enrollment-confirm-saved').checked = false; $('enrollment-authorize').disabled = true;
  $('enrollment-dialog').showModal(); notice('先保存加入材料，再授权其摘要；关闭不会注册服务器。');
}
function cancel() {
  if (busy) return; const uncertain = pending?.uncertain; pending = null; $('enrollment-dialog').close(); notice(uncertain ? '授权可能已记录；关闭仅隐藏材料，请使用原文件刷新核对。' : '已取消授权；未提交注册。已下载材料尚未获得加入权限。');
}
$('enrollment-cancel').addEventListener('click', cancel);
$('enrollment-dialog').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('enrollment-download').addEventListener('click', () => {
  if (!pending || busy) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(pending.seed, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `springbok-join-${pending.seed.enrollmentId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); pending.downloaded = true;
  notice('已发起材料下载。请确认文件保存成功；该文件含一次性秘密，请只交给目标节点。');
});
$('enrollment-confirm-saved').addEventListener('change', () => { $('enrollment-authorize').disabled = busy || !pending?.downloaded || !$('enrollment-confirm-saved').checked || pending.uncertain; });
$('enrollment-authorize').addEventListener('click', async () => {
  if (busy || !pending?.downloaded || pending.uncertain || !$('enrollment-confirm-saved').checked) return;
  const version = generation, value = pending; busy = true; $('enrollment-authorize').disabled = true; $('enrollment-cancel').disabled = true;
  controller = new AbortController(); notice('授权一次性加入…');
  try {
    const result = await call('/api/admin/enrollments', { id: value.seed.enrollmentId, revision: value.revision, serverId: value.seed.nodeId, challengeDigest: value.challengeDigest }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
    if (version !== generation) return;
    notice(result.reconciliationRequired ? '目录已记录，节点准备待核对；保留原材料。' : '已准备一次性加入；请在期限内把材料交给该目标节点。');
    pending = null; $('enrollment-dialog').close(); await reload();
  } catch {
    if (version === generation) { value.uncertain = true; notice(`授权结果未确认。保留原材料，刷新并核对 ${value.seed.enrollmentId}，不要重新生成挑战。`); }
  } finally { if (version === generation) { busy = false; $('enrollment-cancel').disabled = false; } }
});
async function inspect(server) {
  if (busy || !session) return;
  const version = generation; busy = true; controller = new AbortController(); $('enrollment-finish').hidden = true;
  try {
    const result = await call(`/api/admin/enrollments/${server.id}`, null, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
    if (version !== generation) return;
    const record = result.enrollment;
    notice(record ? `加入 ${record.enrollmentId}：目录 ${record.state}；节点 ${result.node.status}。期限 ${new Date(record.expiresAt).toLocaleString()}；这不是在线或部署证明。` : '没有已授权的加入记录。');
    if (record && ['unprepared', 'joined'].includes(result.node.status) && record.state === 'enrolling') {
      $('enrollment-finish').hidden = false;
      $('enrollment-finish').onclick = () => reconcile(server.id, record.enrollmentId);
    }
  } catch { if (version === generation) notice('加入状态未确认；请重新验证身份并核对原材料。'); }
  finally { if (version === generation) busy = false; }
}
async function reconcile(serverId, enrollmentId) {
  if (busy || !session) return; const version = generation; busy = true; controller = new AbortController(); $('enrollment-finish').disabled = true;
  try {
    await call('/api/admin/enrollments/reconcile', { serverId, enrollmentId }, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
    if (version !== generation) return; await reload();
  } catch { if (version === generation) notice('核对未完成；保留同一个 enrollment 和节点秘密，不重新加入。'); }
  finally { if (version === generation) { busy = false; $('enrollment-finish').disabled = false; } }
}
export function enrollmentAction(server, revision) {
  if (!session || !['draft', 'enrolling', 'active'].includes(server.state)) return null;
  const button = document.createElement('button'); button.type = 'button'; button.disabled = busy;
  button.textContent = server.state === 'draft' ? '准备一次性加入' : '核对加入状态';
  button.addEventListener('click', () => { void (server.state === 'draft' ? begin(server, revision) : inspect(server)); });
  return button;
}
