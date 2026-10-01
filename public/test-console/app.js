'use strict';
const names = { gateway: 'Gateway 网关', forum: '论坛', game: '在线游戏', account: '账号服务' };
const phases = { ready: '待测试', testing: '测试执行中', tested: '待测试验收', approved: '已测试验收', promoting: '晋级执行中', live: '测试版本已晋级', 'test-failed': '测试失败', 'production-failed': '晋级失败', 'rolling-back': '回滚执行中', 'rollback-failed': '回滚失败', 'rolled-back': '已回滚' };
const cards = document.querySelector('#services'), notice = document.querySelector('#notice');
let state, busy = false;
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
    actions.append(button('执行真实测试', !unknown && ['ready', 'test-failed', 'tested', 'approved'].includes(phase), () => action(spec.id, 'test')));
    const label = el('label', undefined, 'approval'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.disabled = busy || unknown || phase !== 'tested';
    label.append(checkbox, el('span', '我已查看测试证据；这仅是测试验收，不是生产授权'));
    const approve = button('确认测试验收', false, () => action(spec.id, 'approve', { binding: state.bindings[spec.id], acknowledged: true }));
    checkbox.onchange = () => { approve.disabled = busy || unknown || phase !== 'tested' || !checkbox.checked; }; actions.append(label, approve);
    actions.append(button('晋级测试版本', !unknown && phase === 'approved', () => action(spec.id, 'promote')));
    const target = phase === 'production-failed' ? record.active : phase === 'rollback-failed' ? record.pendingRollback : record.previous;
    actions.append(button('回滚已知成功版本', !unknown && ['live', 'production-failed', 'rollback-failed'].includes(phase) && !!target, () => action(spec.id, 'rollback')));
    for (const request of pending) {
      card.append(el('p', `请求 ${request.input.id} · ${request.status} · Update ${request.updateId || '未知'}`, 'digest'));
      if (request.status === 'accepted') actions.append(button('刷新执行证据', true, () => send('/api/reconcile', { id: request.input.id })));
    }
    card.append(actions); cards.append(card);
  }
  const history = document.querySelector('#history'); history.replaceChildren();
  for (const event of [...state.history].reverse()) history.append(el('li', `#${event.revision} ${event.kind} · ${event.input?.service || event.requestId || ''}${event.updateId ? ` · Update ${event.updateId}` : ''}${event.evidence ? ` · ${event.kind === 'health-failure' ? '容器明确失败' : event.evidence.success ? '已验证成功' : '已验证失败'}` : ''}`));
  document.querySelector('#refresh').disabled = busy;
}
document.querySelector('#refresh').onclick = () => refresh().catch(() => { notice.textContent = '读取失败'; });
refresh().then(() => { notice.textContent = '固定样例资源已就绪；所有执行均在临时测试机'; }).catch(() => { notice.textContent = '读取失败'; });
