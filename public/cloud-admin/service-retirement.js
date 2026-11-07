const openRetirements = new Set();
export async function retireService(state, trigger, { request, refresh, notice, current }) {
  if (openRetirements.has(state.instance.id)) return;
  openRetirements.add(state.instance.id);
  const dialog = document.createElement('dialog');
  dialog.className = 'service-delete-dialog';
  const title = document.createElement('h2'); title.textContent = '退役登记 · ' + state.instance.environment;
  const risk = document.createElement('p'); risk.textContent = '退役后将从当前服务列表移除，历史记录保留。';
  const list = document.createElement('dl'), message = document.createElement('p'); message.setAttribute('role', 'status'); message.textContent = '正在核对资源是否已不存在';
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '取消';
  const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'danger'; submit.textContent = '确认退役登记'; submit.disabled = true;
  actions.append(close, submit); dialog.append(title, risk, list, message, actions); document.body.append(dialog);
  let review = null, submitting = false;
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener('close', () => { review = null; openRetirements.delete(state.instance.id); dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  dialog.showModal();
  try {
    const result = await request('/api/admin/deployments/retire-plan', { instanceId: state.instance.id, previousTaskId: state.taskId });
    if (!current()) { dialog.close(); return; }
    if (!dialog.open) return;
    review = result;
    for (const row of result.plan.resources) {
      const term = document.createElement('dt'), value = document.createElement('dd');
      term.textContent = row.kind; value.textContent = `${row.name} · ${row.remoteId} · ${row.accountId} · 已不存在`; list.append(term, value);
    }
    message.textContent = ''; submit.disabled = false;
  } catch { if (dialog.open) message.textContent = '无法证明资源均已不存在，请检查资源状态与连接权限'; }
  submit.addEventListener('click', async () => {
    if (!review || submitting || !current()) return;
    if (Date.now() >= review.expiresAt) { review = null; submit.disabled = true; message.textContent = '确认已过期，请关闭后重新核对'; return; }
    submitting = true; submit.disabled = close.disabled = true; message.textContent = '正在退役登记';
    try {
      const result = await request('/api/admin/deployments/retire-submit', review);
      if (!current()) { dialog.close(); return; }
      if (result.status !== 'retired') throw new Error('retirement unconfirmed');
      dialog.close(); notice('旧服务登记已退役', 'success');
    } catch { if (dialog.open) message.textContent = '退役请求未确认，请刷新实例状态；不要重复提交'; }
    finally { submitting = false; review = null; close.disabled = false; if (current()) await refresh(); }
  });
}
