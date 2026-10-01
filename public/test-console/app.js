'use strict';
const names = { gateway: 'Gateway 网关', forum: '论坛', game: '在线游戏', account: '账号服务' };
const phases = { ready: '待测试', testing: '测试执行中', tested: '待测试验收', approved: '已测试验收', promoting: '晋级执行中', live: '测试版本已晋级', 'test-failed': '测试失败', 'production-failed': '晋级失败', 'rolling-back': '回滚执行中', 'rollback-failed': '回滚失败', 'rolled-back': '已回滚' };
const cards = document.querySelector('#services'), notice = document.querySelector('#notice');
let state, busy = false, pendingReview = null, reviewGeneration = 0;
const inspections = new Map();
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
async function refresh() { const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw new Error('读取记录失败'); state = await response.json(); render(); }
async function send(path, body) {
  if (busy) return; busy = true; render();
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ revision: state.revision, ...body }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    state = result; notice.textContent = '已更新真实测试记录；请查看状态与证据';
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
  if (!state) return; cards.replaceChildren();
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
  const history = document.querySelector('#history'); history.replaceChildren();
  for (const event of [...state.history].reverse()) history.append(el('li', `#${event.revision} ${event.kind} · ${event.input?.service || event.requestId || ''}${event.updateId ? ` · Update ${event.updateId}` : ''}${event.evidence ? ` · ${event.kind === 'health-failure' ? '容器明确失败' : event.evidence.success ? '已验证成功' : '已验证失败'}` : ''}`));
  document.querySelector('#refresh').disabled = busy;
}
document.querySelector('#refresh').onclick = () => refresh().catch(() => { notice.textContent = '读取失败'; });
refresh().then(() => { notice.textContent = '固定样例资源已就绪；所有执行均在临时测试机'; }).catch(() => { notice.textContent = '读取失败'; });
