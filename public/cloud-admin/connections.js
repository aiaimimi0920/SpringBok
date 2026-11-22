const $ = id => document.getElementById(id);
let session = null, rows = [], generation = 0, controller = null, busy = false, pendingDisable = null, pendingRotate = null, returnFocus = null;
const states = { verified: '只读验证通过', failed: '验证失败，不可用', disabled: '已停用' };
const checks = { 'account-read': 'Cloudflare 账号读取', 'github-account-read':'GitHub 账户身份读取', 'repository-actions-read': 'GitHub 仓库及 Actions 读取', 'verification-failed': '凭据、权限或平台连接异常', 'credential-unavailable': '密钥存储不可用，请联系管理员' };
function notice(text, tone = 'info') { $('connection-status').textContent = text; $('connection-status').dataset.tone = tone; }
function controls() { $('connection-fields').disabled = busy || !session?.connectionsEnabled; $('connections-refresh').disabled = busy; }
function clearSecret() { $('connection-token').value = ''; $('connection-rotate-token').value = ''; }
function resetInput() { $('connection-form').reset(); clearSecret(); providerChanged(); }
function providerChanged() {
  $('connection-token').value = ''; $('connection-target').value = '';
  const github = $('connection-provider').value === 'github';
  $('connection-target-label').textContent = github ? 'GitHub 仓库（owner/repository）' : 'Cloudflare Account ID';
  $('connection-token-label').textContent = github ? 'GitHub PAT' : 'API Token';
  $('connection-target').placeholder = github ? 'owner/repository' : '32 位账号 ID';
}
async function api(body, signal) {
  const response = await fetch('/api/admin/connections', { method: body ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal,
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': session?.csrf ?? '' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 403) throw Object.assign(new Error('身份已失效，请重新登录后刷新'), { unauthorized: true });
  if (response.status === 422) throw new Error('只读验证未通过，未保存凭据。请检查 Token、目标、权限或稍后再试');
  if (!response.ok) throw new Error('请求未确认或记录已变化；请先刷新连接，不要重复提交');
  return response.json();
}
function render() {
  $('connections-list').replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li'), title = document.createElement('h3'), detail = document.createElement('p'), state = document.createElement('p'), actions = document.createElement('div');
    li.dataset.state = row.state; li.dataset.connectionId = row.id;
    title.textContent = row.name; detail.textContent = `${row.provider === 'cloudflare' ? 'Cloudflare' : 'GitHub'} · ${row.target}`;
    state.className = 'connection-state'; state.textContent = `${states[row.state] ?? '未知状态'} · ${checks[row.check] ?? '未验证'} · ${new Date(row.checkedAt).toLocaleString()}`;
    actions.className = 'actions';
    const buttons = [['重新验证', 'verify'], ...(row.parentId ? [] : [['更新凭据', 'rotate']]), ['停用', 'disable']];
    for (const [label, action] of buttons) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = busy || row.state === 'disabled';
      button.dataset.actionKey = `${row.id}/${action}`;
      if (action === 'disable') button.className = 'danger';
      button.addEventListener('click', () => {
        if (busy || !session) return;
        if (action === 'verify') void mutate({ action, id: row.id, revision: row.revision });
        else if (action === 'rotate') {
          pendingRotate = row; returnFocus = button;
          $('connection-rotate-target').textContent = `${row.name} · ${row.target}`;
          $('connection-rotate-token').value = '';
          $('connection-rotate-dialog').showModal(); $('connection-rotate-token').focus();
        } else {
          pendingDisable = row; returnFocus = button;
          $('connection-disable-target').textContent = row.name;
          $('connection-disable-dialog').showModal(); $('connection-disable-cancel').focus();
        }
      }); actions.append(button);
    }
    li.append(title, detail, state, actions); $('connections-list').append(li);
  }
  if (!rows.length) { const li = document.createElement('li'); li.className = 'empty-state'; li.textContent = '尚未添加连接'; $('connections-list').append(li); }
}
function restoreTriggerFocus() {
  const key = returnFocus?.dataset?.actionKey; returnFocus = null;
  if (!key) return;
  const target = document.querySelector(`[data-action-key="${CSS.escape(key)}"]`);
  target?.focus();
}
function invalidate() {
  generation++; controller?.abort(); controller = null; session = null; rows = []; clearSecret(); pendingDisable = null; pendingRotate = null; returnFocus = null;
  if ($('connection-disable-dialog').open) $('connection-disable-dialog').close();
  if ($('connection-rotate-dialog').open) $('connection-rotate-dialog').close();
  $('connection-identity').textContent = '需要重新验证管理员身份'; $('connections-list').replaceChildren(); controls();
}
async function refresh() {
  if (busy) return; invalidate(); const version = generation; controller = new AbortController(); notice('读取连接…');
  try {
    const response = await fetch('/api/admin/state', { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error('身份验证失败，请重新登录');
    const value = await response.json(); if (version !== generation) return;
    session = value; $('connection-identity').textContent = `管理员：${value.email}`;
    if (!value.connectionsEnabled) { notice('连接管理尚未启用：需要服务端凭据加密密钥和存储配置', 'warning'); return; }
    const result = await api(null, controller.signal); if (version !== generation) return;
    rows = result.connections; render(); notice('连接已刷新');
  } catch (error) { if (version === generation) { invalidate(); notice(error.message, 'error'); } }
  finally { if (version === generation) controls(); }
}
async function mutate(body) {
  if (busy || !session?.connectionsEnabled) return false;
  busy = true; const version = generation; controls(); render(); clearSecret(); notice(body.action === 'disable' ? '正在停用…' : '正在验证，请稍候…');
  try {
    const result = await api(body); if (version !== generation) return false;
    rows = [...rows.filter(row => row.id !== result.connection.id), result.connection];
    if (body.action === 'create') resetInput();
    notice(result.connection.state === 'failed' ? '验证失败，已标记为不可用；请检查权限或平台状态' : body.action === 'disable' ? '连接已停用' : body.action === 'rotate' ? '凭据已更新，只读验证通过' : '连接已保存，只读验证通过', result.connection.state === 'failed' ? 'error' : body.action === 'disable' ? 'info' : 'success');
    return true;
  } catch (error) {
    if (version === generation) {
      if (error?.unauthorized) invalidate();
      notice(error.message, 'error');
    }
    return false;
  } finally { body.token = undefined; busy = false; controls(); if (version === generation && session) render(); }
}
$('connection-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || !session?.connectionsEnabled) return;
  void mutate({ action: 'create', id: crypto.randomUUID(), name: $('connection-name').value,
    provider: $('connection-provider').value, target: $('connection-target').value, token: $('connection-token').value });
});
$('connection-provider').addEventListener('change', providerChanged);
$('connection-clear').addEventListener('click', resetInput);
$('connections-refresh').addEventListener('click', refresh);
function cancelDisable() { pendingDisable = null; if ($('connection-disable-dialog').open) $('connection-disable-dialog').close(); }
$('connection-disable-cancel').addEventListener('click', cancelDisable);
$('connection-disable-dialog').addEventListener('close', () => { pendingDisable = null; restoreTriggerFocus(); });
$('connection-disable-confirm').addEventListener('click', () => { const row = pendingDisable; pendingDisable = null; $('connection-disable-dialog').close(); if (row) void mutate({ action: 'disable', id: row.id, revision: row.revision }); });
function cancelRotate() { pendingRotate = null; $('connection-rotate-token').value = ''; if ($('connection-rotate-dialog').open) $('connection-rotate-dialog').close(); }
$('connection-rotate-cancel').addEventListener('click', cancelRotate);
$('connection-rotate-dialog').addEventListener('close', () => { pendingRotate = null; $('connection-rotate-token').value = ''; restoreTriggerFocus(); });
$('connection-rotate-form').addEventListener('submit', async event => {
  event.preventDefault(); const row = pendingRotate, token = $('connection-rotate-token').value;
  $('connection-rotate-token').value = '';
  if (!row || busy || !session?.connectionsEnabled) return;
  pendingRotate = null; $('connection-rotate-dialog').close();
  await mutate({ action: 'rotate', id: row.id, revision: row.revision, token });
});
addEventListener('pagehide', invalidate);
addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
providerChanged(); void refresh();
