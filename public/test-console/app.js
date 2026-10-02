import { historyRows, pageRows, eventRow } from './history.mjs';
'use strict';
const names = { gateway: 'Gateway 网关', forum: '论坛', game: '在线游戏', account: '账号服务' };
const phases = { ready: '待测试', testing: '测试执行中', tested: '待测试验收', approved: '已测试验收', promoting: '晋级执行中', live: '测试版本已晋级', 'test-failed': '测试失败', 'production-failed': '晋级失败', 'rolling-back': '回滚执行中', 'rollback-failed': '回滚失败', 'rolled-back': '已回滚' };
const cards = document.querySelector('#services'), notice = document.querySelector('#notice');
let historyPage = 1, auditPage = 1;
let state, busy = false, pendingReview = null, reviewGeneration = 0;
const inspections = new Map();
let readinessRequest = null, readinessResult = null, readinessGeneration = 0;
const resourceLabels = { matched: '完整配置匹配目录', missing: '资源缺失', 'identity-mismatch': '资源身份不符', 'configuration-unknown': '配置或服务器映射未知', unavailable: '暂时无法读取', timeout: '读取超时' };
const serverLabels = { 'cached-ok': 'Core 缓存：Ok', 'cached-not-ok': 'Core 缓存：NotOk', 'cached-disabled': 'Core 缓存：Disabled', unknown: '缓存状态未知', unavailable: '缓存暂不可读', timeout: '缓存读取超时', 'not-checked': '未读取服务器状态' };
const recordLabels = { unknown: '执行记录未知，保持阻断', pending: '执行结果仍待核对', 'no-pending-record': '无未决执行记录（非发布许可）' };
function renderReadiness() {
  document.querySelector('#readiness-check').disabled = busy;
  document.querySelector('#readiness-cancel').disabled = !readinessRequest;
  document.querySelector('#readiness-close').hidden = !readinessResult;
  const box = document.querySelector('#readiness-results'); box.replaceChildren();
  if (!readinessResult) return;
  if (readinessResult.revision !== state.revision) { readinessResult = null; document.querySelector('#readiness-status').textContent = '记录已变化，请重新检查'; document.querySelector('#readiness-close').hidden = true; return; }
  box.append(el('h3', readinessResult.observation === 'matched' ? '固定资源观测匹配（非发布授权）' : '部分资源需要核对'));
  box.append(el('p', `只读观测 ${readinessResult.observedAt} · 记录版本 ${readinessResult.revision}`, 'digest'));
  const list = el('ul', undefined, 'readiness-list');
  for (const row of readinessResult.rows) {
    const item = el('li'); item.append(el('h4', `${names[row.service]} · ${row.role === 'test' ? '测试' : '临时生产角色'}`),
      el('p', `${row.name} · ${row.id}`, 'digest'), el('p', resourceLabels[row.resource]), el('p', serverLabels[row.server]),
      el('p', recordLabels[row.recordState]));
    if (row.artifact) item.append(el('p', `已知镜像 ${row.artifact}`, 'digest'));
    list.append(item);
  }
  box.append(list);
}
function cancelReadiness() {
  readinessGeneration++; readinessResult = null; readinessRequest?.abort();
  document.querySelector('#readiness-status').textContent = '已取消等待；不会显示迟到结果，也不会执行部署';
  if (state) renderReadiness();
}
document.querySelector('#readiness-check').onclick = async () => {
  if (busy) return;
  const request = new AbortController(), generation = ++readinessGeneration;
  readinessRequest = request; readinessResult = null; busy = true;
  document.querySelector('#readiness-status').textContent = '正在只读核对固定资源…'; render();
  try {
    const response = await fetch('/api/readiness', { method: 'POST', signal: request.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ revision: state.revision }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    if (generation !== readinessGeneration) return;
    readinessResult = result; document.querySelector('#readiness-status').textContent = '读取完成；没有更改资源、发布记录或验收权限';
  } catch (error) { if (generation === readinessGeneration) document.querySelector('#readiness-status').textContent = error.message; }
  finally { if (readinessRequest === request) { readinessRequest = null; busy = false; render(); } }
};
document.querySelector('#readiness-cancel').onclick = cancelReadiness;
document.querySelector('#readiness-close').onclick = () => { readinessResult = null; document.querySelector('#readiness-status').textContent = '已关闭检查结果'; renderReadiness(); };
window.addEventListener('pagehide', cancelReadiness);
window.addEventListener('popstate', () => { if (readinessRequest || readinessResult) cancelReadiness(); });
const dialog = document.querySelector('#execution-review');
const reviewSubmit = document.querySelector('#review-submit');
const operationNames = { test: '执行测试', promote: '晋级测试版本', rollback: '回滚已知成功版本' };
function cancelReview() { reviewGeneration++; pendingReview = null; reviewSubmit.disabled = true; if (dialog.open) dialog.close(); }
async function review(service, operation) {
  if (busy) return;
  cancelReview(); const generation = reviewGeneration;
  const body = { revision: state.revision, id: crypto.randomUUID(), service, operation };
  busy = true; render(); document.querySelector('#review-details').replaceChildren();
  document.querySelector('#review-status').textContent = '正在读取计划；尚未执行'; dialog.showModal();
  document.querySelector('#review-cancel').focus();
  try {
    const response = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    if (generation !== reviewGeneration || !dialog.open) return;
    pendingReview = result;
    const details = document.querySelector('#review-details');
    const values = [['服务', names[result.service]], ['操作', operationNames[result.operation]],
      ['目标环境', result.operation === 'test' ? '临时测试环境' : '临时生产角色（非真实生产）'],
      ['目标资源', result.plan.name], ['资源 ID', result.plan.target], ['不可变镜像', result.plan.artifact],
      ['发布配置摘要', result.plan.configDigest], ['目标配置摘要', result.plan.targetConfigDigest], ['记录版本', String(result.revision)]];
    for (const [label, value] of values) details.append(el('dt', label), el('dd', value));
    document.querySelector('#review-status').textContent = '请核对目标与版本。计划两分钟内有效；记录变化或重启后必须重新确认。';
    reviewSubmit.disabled = false;
  } catch (error) {
    if (generation === reviewGeneration && dialog.open) document.querySelector('#review-status').textContent = error.message;
  } finally { busy = false; render(); }
}
for (const id of ['review-cancel', 'review-close']) document.querySelector(`#${id}`).onclick = cancelReview;
dialog.addEventListener('cancel', event => { event.preventDefault(); cancelReview(); });
dialog.addEventListener('close', () => { pendingReview = null; reviewSubmit.disabled = true; });
reviewSubmit.onclick = () => {
  if (busy || !pendingReview) return;
  const { plan: _plan, ...body } = pendingReview; cancelReview(); send('/api/action', body);
};
window.addEventListener('popstate', cancelReview);
window.addEventListener('pagehide', cancelReview);
window.addEventListener('pageshow', event => { if (event.persisted) { cancelReview(); refresh().catch(() => { notice.textContent = '读取失败'; }); } });
function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function button(label, enabled, callback) { const b = el('button', label); b.type = 'button'; b.disabled = busy || !enabled; b.onclick = callback; return b; }
async function refresh() { const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw new Error('读取记录失败'); state = await response.json(); historyPage = 1; auditPage = 1; render(); }
async function send(path, body) {
  if (busy) return; busy = true; render();
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ revision: state.revision, ...body }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    state = result; historyPage = 1; auditPage = 1; notice.textContent = '已更新真实测试记录；请查看状态与证据';
  } catch (error) { notice.textContent = error.message; try { await refresh(); } catch { /* Never retry a write. */ } }
  finally { busy = false; render(); }
}
const action = (service, operation, extra = {}) => send('/api/action', { id: crypto.randomUUID(), service, operation, ...extra });
async function inspect(service, id) {
  if (busy) return; busy = true; inspections.delete(service); notice.textContent = '正在只读查看证据…'; render();
  try {
    const response = await fetch('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ revision: state.revision, id }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    inspections.set(service, result); notice.textContent = '已只读查看证据；没有更改发布记录、配置或容器';
  } catch (error) { notice.textContent = error.message; }
  finally { busy = false; render(); }
}

function render() {
  if (!state) return; renderReadiness(); cards.replaceChildren();
  for (const record of state.services) {
    const { spec, phase } = record;
    const pending = state.requests.filter(r => r.input.service === spec.id && ['accepted', 'unknown'].includes(r.status));
    const unknown = pending.some(r => r.status === 'unknown') || state.preparation.some(r => r.service === spec.id && r.status === 'unknown');
    const card = el('article', undefined, 'card'); card.setAttribute('aria-label', names[spec.id]);
    const top = el('div', undefined, 'card-top'); top.append(el('h2', names[spec.id]), el('span', unknown ? '结果未知 · 已阻断' : phases[phase] || phase, 'phase')); card.append(top);
    const version = Object.keys(state.versions).find(v => state.versions[v] === spec.artifact);
    card.append(el('p', `候选 ${version} · ${spec.artifact}`, 'digest'), el('p', `当前成功版本：${record.active?.artifact || '尚无'}`, 'digest'));

    if (unknown) card.append(el('p', '提交结果未知：已阻断，禁止自动重试'));
    const actions = el('div', undefined, 'actions');
    const select = el('select'); select.setAttribute('aria-label', `${names[spec.id]}候选版本`);
    for (const v of ['v1', 'v2', 'bad']) { const o = el('option', v === 'bad' ? '坏镜像（失败测试）' : v); o.value = v; select.append(o); } select.value = version;
    actions.append(select, button('选择候选', !unknown && ['ready', 'test-failed', 'tested', 'approved', 'live', 'rolled-back'].includes(phase), () => action(spec.id, 'candidate', { version: select.value })));
    actions.append(button('执行真实测试', !unknown && ['ready', 'test-failed', 'tested', 'approved'].includes(phase), () => review(spec.id, 'test')));
    const label = el('label', undefined, 'approval'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.disabled = busy || unknown || phase !== 'tested';
    label.append(checkbox, el('span', '我已查看测试证据；这仅是测试验收，不是生产授权'));
    const approve = button('确认测试验收', false, () => action(spec.id, 'approve', { binding: state.bindings[spec.id], acknowledged: true }));
    checkbox.onchange = () => { approve.disabled = busy || unknown || phase !== 'tested' || !checkbox.checked; }; actions.append(label, approve);
    actions.append(button('晋级测试版本', !unknown && phase === 'approved', () => review(spec.id, 'promote')));
    const target = phase === 'production-failed' ? record.active : phase === 'rollback-failed' ? record.pendingRollback : record.previous;
    actions.append(button('回滚已知成功版本', !unknown && ['live', 'production-failed', 'rollback-failed'].includes(phase) && !!target, () => review(spec.id, 'rollback')));
    for (const request of pending) {
      card.append(el('p', `请求 ${request.input.id} · ${request.status} · Update ${request.updateId || '未知'}`, 'digest'));
      if (request.status === 'accepted') actions.append(button('刷新执行证据', true, () => send('/api/reconcile', { id: request.input.id })));
    }
    const latest = [...state.requests].reverse().find(r => r.input.service === spec.id && r.plan);
    const preparation = state.preparation.find(r => r.service === spec.id && r.status === 'unknown');
    const inspectionId = preparation?.id || latest?.input.id;
    if (inspectionId) actions.append(button('查看执行证据与阻断原因', true, () => inspect(spec.id, inspectionId)));
    card.append(actions);
    const observation = inspections.get(spec.id);
    if (observation && observation.revision === state.revision && observation.requestId === inspectionId) {
      const panel = el('section', undefined, 'diagnostic'); panel.setAttribute('aria-label', `${names[spec.id]}执行证据`);
      panel.append(el('h3', observation.title), el('p', observation.detail), el('p', `下一步：${observation.next}`));
      panel.append(el('p', `只读观测时间：${observation.observedAt} · 记录版本 ${observation.revision}`, 'digest'));
      panel.append(el('p', `请求 ${observation.requestId} · Update ${observation.updateId || '未知'} · 目标 ${observation.target}`, 'digest'));
      panel.append(button('关闭证据说明', true, () => { inspections.delete(spec.id); render(); })); card.append(panel);
    }
    cards.append(card);
  }
  renderHistory();
  document.querySelector('#refresh').disabled = busy;
}
document.querySelector('#refresh').onclick = () => refresh().catch(() => { notice.textContent = '读取失败'; });
refresh().then(() => { notice.textContent = '固定样例资源已就绪；所有执行均在临时测试机'; }).catch(() => { notice.textContent = '读取失败'; });

const historyLabels = { unknown: '结果未知，保持阻断', accepted: '已取得回执，结果待核对', succeeded: '已验证成功', failed: '已验证失败', completed: '本地操作已记录', revoked: '测试验收已撤销' };
const historyOperations = { ...operationNames, candidate: '选择候选', approve: '确认测试验收' };
function eventText(e) { return `${e.source === 'execution' ? '执行' : '准备'} #${e.revision} ${e.kind}${e.requestId ? ` · 请求 ${e.requestId}` : ''}${e.updateId ? ` · Update ${e.updateId}` : ''}`; }
function renderHistory() {
  const list = document.querySelector('#history'); list.replaceChildren();
  try {
    const model = historyRows(state), service = document.querySelector('#history-service').value;
    const result = pageRows(model, service, historyPage); historyPage = result.page;
    document.querySelector('#history-status').textContent = result.total ? `共 ${result.total} 条 · 第 ${result.page} / ${result.pages} 页` : '此服务暂无请求记录';
    document.querySelector('#history-prev').disabled = result.page === 1;
    document.querySelector('#history-next').disabled = result.page === result.pages;
    for (const row of result.rows) {
      const li = el('li'), details = el('details'), summary = el('summary', `${names[row.service]} · ${historyOperations[row.operation] || '未知操作'} · ${historyLabels[row.status] || '状态未知'} · ${row.source === 'execution' ? '执行' : '准备'} #${row.revision}`);
      details.append(summary, el('p', `请求 ${row.id}`, 'digest'));
      details.append(el('p', `${row.source === 'execution' ? '执行起始' : '准备独有；未确认执行'} #${row.revision}`));
      if (row.target) details.append(el('p', `目标 ${row.target}`, 'digest'));
      if (row.artifact) details.append(el('p', `镜像 ${row.artifact}`, 'digest'));
      if (row.updateId) details.append(el('p', `Update ${row.updateId}`, 'digest'));
      const events = el('ol'); for (const event of row.events) events.append(el('li', eventText(event))); details.append(events); li.append(details); list.append(li);
    }
    const source = document.querySelector('#audit-source').value;
    const audit = (source === 'execution' ? state.history : state.preparationHistory).map(e => eventRow(e, source)).reverse();
    const resultAudit = pageRows(audit, 'all', auditPage); auditPage = resultAudit.page;
    const auditList = document.querySelector('#audit-events'); auditList.replaceChildren();
    for (const event of resultAudit.rows) auditList.append(el('li', eventText(event)));
    document.querySelector('#audit-status').textContent = `共 ${resultAudit.total} 个事件 · 第 ${resultAudit.page} / ${resultAudit.pages} 页`;
    document.querySelector('#audit-prev').disabled = resultAudit.page === 1;
    document.querySelector('#audit-next').disabled = resultAudit.page === resultAudit.pages;
  } catch {
    document.querySelector('#history-status').textContent = '记录关联不完整或不一致，无法生成摘要；请保留原始日志';
    for (const id of ['history-prev', 'history-next', 'audit-prev', 'audit-next']) document.querySelector(`#${id}`).disabled = true;
    document.querySelector('#audit-events').replaceChildren();
  }
}
document.querySelector('#history-service').onchange = () => { historyPage = 1; renderHistory(); };
document.querySelector('#audit-source').onchange = () => { auditPage = 1; renderHistory(); };
for (const [id, delta] of [['history-prev', -1], ['history-next', 1]]) document.querySelector(`#${id}`).onclick = () => { historyPage += delta; renderHistory(); };
for (const [id, delta] of [['audit-prev', -1], ['audit-next', 1]]) document.querySelector(`#${id}`).onclick = () => { auditPage += delta; renderHistory(); };
