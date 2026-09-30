(() => {
  'use strict';
  const service = document.querySelector('#preview-service');
  const scenario = document.querySelector('#preview-scenario');
  const operation = document.querySelector('#preview-operation');
  const status = document.querySelector('#preview-status');
  const result = document.querySelector('#preview-result');
  const reasons = {
    'unresolved-execution': '提交结果未知：禁止再次提交，只能等待有依据的核对',
    'approval-required': '缺少当前候选的人工验收',
    'no-known-good-release': '没有已成功版本，不能生成回滚目标',
    'phase-blocked': '当前流程状态不允许此操作',
    'inventory-unknown': '资源配置无法确认，不能发布',
    'configuration-preparation-required': '目标配置尚未准备：此预览不会写入部署配置',
    'state-unconfirmed': '没有可确认的成功记录，当前状态未知',
    'fixture-contract-only': '仅合成记录满足契约条件，仍不具备真实执行权限',
  };
  let sequence = 0, controller;
  function node(tag, text, className) {
    const el = document.createElement(tag); el.textContent = text;
    if (className) el.className = className; return el;
  }
  function render(data) {
    result.replaceChildren(); result.dataset.scenario = data.scenario; result.dataset.operation = data.operation;
    const details = node('dl', '', 'details');
    for (const [label, value] of [
      ['数据来源', '独立合成记录 · 未连接服务器'],
      ['目标名称', data.plan?.name || '尚无允许的目标'], ['目标 ID', data.plan?.target || '未知'],
      ['候选制品', data.plan?.artifact || '未知'], ['目标配置摘要', data.plan?.targetConfigDigest || '未知'],
      ['当前已知状态', data.current.status === 'unknown' ? '未知，不可发布' : '仅合成成功记录与合成清单一致'],
      ['回滚条件', data.rollbackAvailable ? '合成记录存在已成功目标；仍须准备配置与真实授权' : '本预览未确认可回滚条件'],
    ]) details.append(node('dt', label), node('dd', value, 'digest'));
    result.append(details);
    if (data.changes.length) {
      const table = document.createElement('table'); table.className = 'plan-diff';
      const caption = node('caption', '与最近可确认的合成成功状态比较'); table.append(caption);
      const head = document.createElement('thead'), header = document.createElement('tr');
      for (const title of ['字段', '已知状态', '计划值']) { const th = node('th', title); th.scope = 'col'; header.append(th); }
      head.append(header); table.append(head);
      const body = document.createElement('tbody');
      for (const change of data.changes) {
        const tr = document.createElement('tr');
        const title = node('th', change.field === 'artifact' ? '镜像' : '配置'); title.scope = 'row'; tr.append(title);
        tr.append(node('td', change.from || '未知', 'digest'), node('td', `${change.to} · ${change.changed === null ? '差异未知' : change.changed ? '有变化' : '相同'}`, 'digest'));
        body.append(tr);
      }
      table.append(body); result.append(table);
    }
    status.textContent = reasons[data.reason] || '计划无法确认，不能执行';
    status.className = data.reason === 'unresolved-execution' ? 'error' : '';
  }
  async function refreshPlan() {
    const current = ++sequence; controller?.abort(); controller = new AbortController();
    result.replaceChildren(); delete result.dataset.scenario; delete result.dataset.operation;
    status.textContent = '正在读取合成计划…';
    try {
      const params = new URLSearchParams({ service: service.value, scenario: scenario.value, operation: operation.value });
      const response = await fetch(`/api/plan?${params}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('invalid preview');
      const data = await response.json(); if (current === sequence) render(data);
    } catch (error) {
      if (current === sequence && error.name !== 'AbortError') status.textContent = '计划无法读取，状态未知；没有执行任何操作';
    }
  }
  for (const select of [service, scenario, operation]) select.addEventListener('change', refreshPlan);
  refreshPlan();
})();
