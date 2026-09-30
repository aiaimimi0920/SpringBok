'use strict';
const names = { gateway: 'Gateway 网关', forum: '论坛', game: '在线游戏', account: '账号服务' };
const phases = { ready: '待模拟测试', tested: '待模拟验收', approved: '已模拟验收', live: '模拟版本已晋级', 'test-failed': '模拟测试失败', 'production-failed': '模拟晋级失败', 'rollback-failed': '模拟回滚失败', 'rolled-back': '已模拟回滚' };
const verbs = { candidate: '选择候选', test: '模拟测试', approve: '模拟验收', promote: '模拟晋级', rollback: '模拟回滚' };
const cards = document.querySelector('#services');
const notice = document.querySelector('#notice');
let state;
let busy = false;
function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function message(text, error = false) { notice.textContent = text; notice.className = error ? 'error' : ''; }
function button(text, enabled, action, primary = false) {
  const e = element('button', text, primary ? 'primary' : '');
  e.type = 'button'; e.disabled = busy || !enabled; e.addEventListener('click', action); return e;
}
async function refresh() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取演示记录，请检查服务是否运行');
  state = await response.json(); render();
}
async function submit(service, action, extra = {}) {
  if (busy) return;
  busy = true; render();
  try {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
      body: JSON.stringify({ revision: state.revision, service, action, ...extra }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成');
    state = result;
    message(`${names[service]}：${verbs[action]}已记录${extra.success === false ? '（模拟失败）' : ''}。没有执行真实部署。`);
  } catch (error) {
    message(error.message, true);
    try { await refresh(); } catch { /* Preserve the action error and never retry a mutation. */ }
  } finally { busy = false; render(); }
}
function render() {
  if (!state) return;
  cards.replaceChildren();
  for (const record of state.services) {
    const { spec, phase } = record;
    const card = element('article', undefined, 'card'); card.setAttribute('aria-label', names[spec.id]);
    const top = element('div', undefined, 'card-top');
    const title = element('div'); title.append(element('h2', names[spec.id]), element('p', spec.id, 'service-id'));
    top.append(title, element('span', phases[phase] || phase, `phase${phase.includes('failed') ? ' bad' : ''}`)); card.append(top);
    const details = element('dl', undefined, 'details');
    for (const [key, value] of [['测试目标', spec.testTarget], ['晋级目标', `${spec.productionTarget}（模拟）`], ['候选制品', `${state.demoVersions[spec.id].candidate} · ${spec.artifact}`], ['配置摘要', spec.configDigest], ['当前模拟版本', record.active ? `${state.demoVersions[spec.id].active} · ${record.active.artifact}` : '尚无'], ['可回滚版本', (phase === 'production-failed' ? record.active : phase === 'rollback-failed' ? record.pendingRollback : record.previous)?.artifact || '尚无已成功版本']]) {
      details.append(element('dt', key), element('dd', value, key.includes('制品') || key.includes('摘要') || key.includes('版本') ? 'digest' : ''));
    }
    card.append(details);
    const actions = element('div', undefined, 'actions');
    const select = element('select'); select.setAttribute('aria-label', `${names[spec.id]}候选版本`);
    for (const version of ['v1', 'v2']) { const option = element('option', version); option.value = version; select.append(option); }
    select.value = state.demoVersions[spec.id].candidate;
    select.disabled = busy;
    const canCandidate = ['ready', 'test-failed', 'tested', 'approved', 'live', 'rolled-back'].includes(phase);
    actions.append(select, button('选择候选', canCandidate, () => submit(spec.id, 'candidate', { version: select.value })));
    const canTest = ['ready', 'test-failed', 'tested', 'approved'].includes(phase);
    actions.append(button('模拟测试通过', canTest, () => submit(spec.id, 'test', { success: true }), true), button('模拟测试失败', canTest, () => submit(spec.id, 'test', { success: false })));
    const label = element('label', undefined, 'approval'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.disabled = busy || phase !== 'tested';
    label.append(checkbox, element('span', '我已查看此候选版本，仅模拟验收，不是生产授权'));
    const approve = button('确认模拟验收', false, () => submit(spec.id, 'approve', { binding: state.bindings[spec.id], acknowledged: true }), true);
    checkbox.addEventListener('change', () => { approve.disabled = busy || phase !== 'tested' || !checkbox.checked; });
    actions.append(label, approve);
    actions.append(button('模拟晋级', phase === 'approved', () => submit(spec.id, 'promote', { success: true }), true), button('模拟晋级失败', phase === 'approved', () => submit(spec.id, 'promote', { success: false })));
    const target = phase === 'production-failed' ? record.active : phase === 'rollback-failed' ? record.pendingRollback : record.previous;
    const canRollback = ['live', 'production-failed', 'rollback-failed'].includes(phase) && !!target;
    actions.append(button('模拟回滚', canRollback, () => submit(spec.id, 'rollback', { success: true })), button('模拟回滚失败', canRollback, () => submit(spec.id, 'rollback', { success: false })));
    if (phase === 'production-failed' && !record.active) actions.append(element('p', '首次模拟晋级失败，没有已成功版本可回滚；保留失败记录。'));
    card.append(actions); cards.append(card);
  }
  document.querySelector('#revision').textContent = `${state.revision} 条记录 · DEMO`;
  const history = document.querySelector('#history'); history.replaceChildren();
  for (const event of [...state.history].reverse().slice(0, 40)) {
    history.append(element('li', event.kind === 'restart' ? `#${event.revision} 重启恢复：撤销未使用的模拟验收（记录 ${event.invalidated.join('、')}）` : `#${event.revision} ${names[event.input.service]} · ${verbs[event.input.action]}${event.input.version ? ` ${event.input.version}` : ''}${typeof event.input.success === 'boolean' ? (event.input.success ? ' · 模拟成功' : ' · 模拟失败') : ''}`));
  }
  if (!state.history.length) history.append(element('li', '还没有记录。从任一服务的模拟测试开始。'));
  document.querySelector('#refresh').disabled = busy;
}
document.querySelector('#refresh').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try { await refresh(); message('已读取本地演示记录；没有执行真实部署'); }
  catch (error) { message(error.message, true); }
  finally { busy = false; render(); }
});
refresh().then(() => message('选择一个服务，体验固定发布流程。所有按钮仅驱动模拟状态。')).catch(error => message(error.message, true));
