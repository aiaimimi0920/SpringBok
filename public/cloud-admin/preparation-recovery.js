export async function resumePreparation(state, trigger, { request, refresh, notice, current }) {
  const dialog = document.createElement('dialog'); dialog.className = 'service-dialog';
  dialog.setAttribute('aria-label', '继续部署');
  const heading = document.createElement('h2'); heading.textContent = '继续部署';
  const details = document.createElement('dl'), message = document.createElement('p');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'primary'; submit.textContent = '确认继续部署'; submit.disabled = true;
  const actions = document.createElement('div'); actions.className = 'service-dialog-footer'; actions.append(cancel, submit);
  dialog.append(heading, details, message, actions); document.body.append(dialog); dialog.showModal();
  let busy = false, plan = null;
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected && current()) { trigger.disabled = false; trigger.focus(); } });
  message.textContent = '正在核对原任务…';
  try {
    plan = await request('/api/admin/deployments/resume-plan', { taskId: state.taskId });
    if (!current() || !dialog.open) { dialog.close(); return; }
    for (const [label, value] of [['任务', plan.taskId], ['版本', plan.instance.application.version + ' · ' + plan.instance.application.sourceSha], ['环境', plan.instance.environment], ['资源', Object.values(plan.instance.resources).map(row => row.kind + ' · ' + row.name).join('、')]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; details.append(dt, dd);
    }
    message.textContent = '将继续原任务，创建所列服务资源并执行固定版本。';
    submit.disabled = false;
  } catch (error) { message.textContent = error.message; }
  submit.addEventListener('click', async () => {
    if (busy || !plan || !current()) return;
    busy = true; submit.disabled = true; cancel.disabled = true; message.textContent = '正在继续部署…';
    const { instance, ...body } = plan;
    try { await request('/api/admin/deployments/resume-submit', body); if (current()) notice(''); }
    catch { if (current()) notice('继续部署未确认，请查看原任务状态；不要新建任务重试。', 'error'); }
    finally { dialog.close(); if (current()) await refresh(); }
  });
}
