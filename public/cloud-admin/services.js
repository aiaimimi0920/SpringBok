import { boundResources, confirmedVersion, newerVersion, resourceCountText, resourceMetrics, statusText, statusTone, valueAt } from './service-model.mjs';
import { resourceLabels } from './resource-model.mjs';
import { importFields, importWorkerOptions, importDraft, importReview, importedDetails } from './service-import.js';

const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const api = '/api/admin/deployments/';
let session = null, connections = [], generation = 0, dialogGeneration = 0, loadingCount = 0;
let catalog = new Map(), scanning = false, scannedAt = 0, scanErrors = new Map();
let catalogOrder = new Map();
let scanProgress = null;
let instances = new Map(), states = new Map(), usage = new Map(), historyRecords = new Map();
let registeredResources = [], adminProfiles = [], adminOverride = null;
let selected = null, application = null, updateTarget = null, preview = null, busy = false, selectionBusy = false, submitting = false;
let importing = false;
let deletionReview = null, deletionGeneration = 0, deletionSubmitting = false, deletionFocus = null;
let rehearsing = false, deletingPreview = false, testEnvironment = null;
let returnFocus = null, pollTimer = null, listBusy = false, selectedResources = new Map();
const expanded = new Set(), statistics = new Set(), usagePending = new Set();
const notice = (text, tone = 'info') => { $('service-notice').textContent = text; $('service-notice').dataset.tone = tone; };
const dialogNotice = (text, tone = 'info') => { $('service-dialog-notice').textContent = text; $('service-dialog-notice').dataset.tone = tone; };
function loading(delta) { loadingCount = Math.max(0, loadingCount + delta); $('service-loading').textContent = loadingCount ? '正在读取账户与云资源' : ''; }
const ref = id => { const row = connections.find(row => row.id === id && row.state === 'verified' && row.deploymentAvailable !== false); if (!row) throw new Error('连接不可用，请检查连接设置'); return { id: row.id, revision: row.revision }; };
const current = version => version === generation;
const currentDialog = (version, pageVersion) => version === dialogGeneration && current(pageVersion) && $('service-dialog').open;

function controls() {
  $('service-fields').disabled = !session || busy || selectionBusy || submitting || deletingPreview;
  const versionReady = deletingPreview || (!updateTarget || newerVersion(application?.manifest?.version, updateTarget.instance.application.version)) && (!rehearsing || application?.manifest?.schemaVersion === 3 && application?.declaration?.schemaVersion === 2);
  $('service-submit').disabled = !session || busy || selectionBusy || submitting || !application || application.status !== 'ready' || !versionReady || (!preview && !selectedResources.ready) || (preview && !importing && !preview.executionEnabled);
  $('service-submit').textContent = deletingPreview ? '确认删除测试环境' : rehearsing ? (preview ? '确认预升级测试' : '预升级测试') : importing ? (preview ? '确认导入' : '读取服务') : preview ? (updateTarget ? '确认升级' : '确认部署') : (updateTarget ? '升级' : '部署');
  $('service-submit').classList.toggle('danger', deletingPreview); $('service-submit').classList.toggle('primary', !deletingPreview);
  $('service-back').hidden = !preview || deletingPreview; $('service-back').disabled = busy || submitting;
  $('service-edit').hidden = !!preview || application?.status !== 'ready'; $('service-review').hidden = !preview;
  for (const tab of $('service-tabs').children) tab.disabled = busy || submitting;
}
function clearPreview() { preview = null; $('service-review').replaceChildren(); controls(); }
function restoreFocus() {
  const key = returnFocus?.dataset.focusKey;
  const replacement = key && document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  (returnFocus?.isConnected ? returnFocus : replacement || $('service-add')).focus();
}
function invalidate() {
  deletionGeneration++; deletionReview = null; $('service-delete-dialog').close();
  generation++; dialogGeneration++; session = null; clearTimeout(pollTimer); loadingCount = 0; loading(0);
  catalog.clear(); catalogOrder.clear(); instances.clear(); states.clear(); usage.clear(); historyRecords.clear(); usagePending.clear();
  registeredResources = []; adminProfiles = []; adminOverride = null;
  application = null; preview = null; selectedResources = new Map(); busy = false; selectionBusy = false; submitting = false;
  $('service-list').replaceChildren(); $('service-tabs').replaceChildren(); $('service-inputs').replaceChildren(); $('service-resources').replaceChildren(); $('service-review').replaceChildren();
  $('service-dialog').close(); controls();
}
async function request(path, body, timeoutMs = 0) {
  const version = generation;
  const controller = timeoutMs ? new AbortController() : null, timer = controller && setTimeout(() => controller.abort(), timeoutMs);
  try {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error',
    ...(controller ? { signal: controller.signal } : {}),
    headers: body ? { 'content-type': 'application/json', 'x-csrf-token': session?.csrf ?? '' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 403) {
    if (current(version)) { invalidate(); notice('身份验证失败，请重新登录', 'error'); }
    throw new Error('身份验证失败，请重新登录');
  }
  if (!response.ok) throw new Error(path.endsWith('/plan') ? '计划校验失败：检查版本兼容性、连接、资源与公开配置' : '读取或操作未确认，请检查连接权限与平台状态');
  return await response.json();
  } finally { if (timer) clearTimeout(timer); }
}
async function pool(items, callback, count = 2) {
  let next = 0;
  await Promise.all(Array.from({ length: count }, async () => { while (next < items.length) await callback(items[next++]); }));
}
function focusKey(node, key) { node.dataset.focusKey = key; return node; }
function fold(key, label, content) {
  const details = element('details'), summary = focusKey(element('summary', label), key);
  details.open = statistics.has(key); details.append(summary, content);
  details.addEventListener('toggle', () => { if (details.isConnected) details.open ? statistics.add(key) : statistics.delete(key); });
  return details;
}
function renderInstances() {
  const active = document.activeElement?.dataset.focusKey, scroll = $('service-list').scrollTop;
  const rows = [];
  for (const [id, entry] of instances) {
    const state = states.get(id), instance = state?.instance ?? entry.summary, app = instance?.application;
    const status = state?.status ?? state?.job?.status ?? 'loading', confirmed = confirmedVersion(state);
    const li = element('li'); li.dataset.instanceId = id;
    const row = element('div', undefined, 'service-row');
    const title = element('div', undefined, 'service-title'); title.append(element('h2', app?.name ?? '部署任务'), element('p', app?.repository ?? entry.taskId, 'muted'));
    if (instance?.previewOf) title.append(element('small', '预升级测试 · ' + instance.previewOf.environment));
    const version = element('div', undefined, 'service-version');
    version.append(element('span', confirmed ? 'v' + confirmed.version : instance?.action === 'import' ? '版本未知' : app ? '目标 v' + app.version : '—'));
    if (instance?.action === 'update' && !['succeeded', 'deployed-unverified'].includes(status)) version.append(element('small', ' → v' + app.version));
    const target = element('div'); target.append(element('span', instance?.environment ?? '—'), element('small', connections.find(row => row.id === instance?.connections?.cloudflare.id)?.accountName ?? instance?.accountId ?? '—'));
    const label = instance?.action === 'destroy-preview' ? ({ running: '正在清理', failed: '清理失败', unknown: '清理结果未确认' })[status] : null;
    const badge = element('span', label ?? statusText(status), 'service-status'); badge.dataset.tone = statusTone(status);
    const resource = element('div', resourceCountText(instance), 'service-bindings');
    if (instance?.connections) {
      const bound = boundResources(instance), values = bound.slice(0, 2).map(item => `${item.name} ${resourceMetrics(instance, item, usage)[0].text}`);
      resource.append(element('small', values.join(' · ') + (bound.length > 2 ? ` · +${bound.length - 2}` : '')));
    }
    const actions = element('div', undefined, 'service-actions');
    const detail = focusKey(element('button', expanded.has(id) ? '收起' : '详情'), id + '/detail'); detail.type = 'button';
    detail.setAttribute('aria-expanded', String(expanded.has(id))); detail.setAttribute('aria-controls', 'details-' + id);
    detail.addEventListener('click', () => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderInstances(); });
    actions.append(detail);
    if (instance?.previewOf) {
      for (const url of state?.testUrls ?? []) { const link = element('a', '测试地址'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link); }
      const remove = focusKey(element('button', '删除测试环境', 'danger'), id + '/delete-preview'); remove.type = 'button'; remove.disabled = !state?.canDeletePreview || !session;
      remove.addEventListener('click', () => void openDeletePreview(state, remove)); actions.append(remove);
    } else {
      const update = focusKey(element('button', '升级'), id + '/update'); update.type = 'button'; update.disabled = !state?.canUpdate || !session;
      update.addEventListener('click', () => void openDialog(state, update));
      const test = focusKey(element('button', '预升级测试'), id + '/preview'); test.type = 'button'; test.disabled = !state?.canPreview || !session;
      test.addEventListener('click', () => void openDialog(state, test, 'rehearse')); actions.append(update, test);
      const remove = focusKey(element('button', '删除', 'danger'), id + '/delete'); remove.type = 'button'; remove.disabled = !state?.canDelete || !session;
      remove.addEventListener('click', () => void openDeleteService(state, remove)); actions.append(remove);
    }
    row.append(title, version, target, badge, resource, actions); li.append(row);
    const detailPanel = element('div', undefined, 'service-details'); detailPanel.id = 'details-' + id; detailPanel.hidden = !expanded.has(id);
    if (instance) {
      const info = element('dl');
      for (const [name, value] of [['实例', id], ['任务', state?.taskId ?? entry.taskId ?? '—'], ['目标版本', app?.version ? `v${app.version} · ${app.sourceSha}` : '—'], ['最近提交', new Date(entry.createdAt).toLocaleString()], ['错误代码', state?.job?.errorCode ?? state?.errorCode ?? '—']]) info.append(element('dt', name), element('dd', value));
      detailPanel.append(info);
      if (state?.status === 'imported') detailPanel.append(importedDetails(state));
      for (const bound of boundResources(instance)) {
        const metrics = element('dl');
        for (const metric of resourceMetrics(instance, bound, usage)) metrics.append(element('dt', metric.label + ' · ' + metric.periodLabel), element('dd', metric.text));
        const shared = [...instances.values()].filter(other => {
          const candidate = states.get(other.id)?.instance ?? other.summary;
          return boundResources(candidate).some(resource => resource.accountId === bound.accountId && resource.kind === bound.kind && resource.id === bound.id);
        }).length > 1;
        detailPanel.append(fold(id + '/resource/' + bound.accountId + '/' + bound.kind + '/' + bound.id, `${resourceLabels[bound.kind]} · ${bound.name} · ${shared ? '共享资源用量' : '资源级用量'}`, metrics));
      }
      const records = element('div');
      for (const item of state?.history ?? []) {
        const itemRow = element('div', undefined, 'service-history-row');
        const button = focusKey(element('button', `${({ update: '升级', preview: '预升级测试', 'destroy-preview': '删除测试环境' })[item.action] ?? '部署'} · ${item.application ? 'v' + item.application.version : item.taskId} · ${new Date(item.createdAt).toLocaleString()}`), id + '/task/' + item.taskId); button.type = 'button';
        const output = element('pre'), cached = historyRecords.get(item.taskId); if (cached) output.textContent = JSON.stringify(cached.job ?? cached, null, 2);
        button.addEventListener('click', async () => {
          if (historyRecords.has(item.taskId)) { historyRecords.delete(item.taskId); renderInstances(); return; }
          const version = generation; button.disabled = true;
          try { const record = await request(api + 'state', { taskId: item.taskId }); if (current(version)) { historyRecords.set(item.taskId, record); renderInstances(); } }
          catch (error) { if (current(version)) notice(error.message, 'error'); }
          finally { button.disabled = false; }
        });
        itemRow.append(button, output); records.append(itemRow);
      }
      if (state?.status !== 'imported') detailPanel.append(fold(id + '/history', '执行记录 · ' + (state?.history?.length ?? 0), records));
      const result = element('pre', JSON.stringify(state?.deletion ?? (state?.status === 'imported' ? state.provenance : state?.job?.result ?? { status, errorCode: state?.errorCode ?? state?.job?.errorCode ?? null }), null, 2));
      detailPanel.append(fold(id + '/receipt', state?.status === 'imported' ? '导入来源' : '最近回执', result));
      if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(state?.runUrl ?? '')) {
        const link = element('a', 'GitHub Actions'); link.href = state.runUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; detailPanel.append(link);
      }
    }
    li.append(detailPanel); rows.push(li);
  }
  $('service-list').replaceChildren(...rows); $('service-list').scrollTop = scroll;
  $('service-empty').hidden = rows.length > 0;
  if (active) document.querySelector(`[data-focus-key="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
}
async function loadUsage(instance, version) {
  if (!instance?.connections || !session) return;
  const sources = new Map(boundResources(instance).filter(row => row.id && row.connectionId).map(row => [row.connectionId + '/' + row.kind, row]));
  for (const [key, { kind, connectionId }] of sources) {
    if (usagePending.has(key) || Date.now() - (usage.get(key)?.checkedAt ?? 0) < 60000) continue;
    usagePending.add(key);
    try {
      const result = await request('/api/admin/resources', { action: 'usage', connectionId, kind });
      if (current(version)) { usage.set(key, result); renderInstances(); }
    } catch { if (current(version)) usage.set(key, { status: 'unavailable', checkedAt: Date.now() }); }
    finally { if (current(version)) usagePending.delete(key); }
  }
}
async function refreshInstances() {
  if (listBusy || !session) return;
  const version = generation; listBusy = true;
  try {
    const result = await request(api + 'services'); if (!current(version)) return;
    for (const entry of result.services) instances.set(entry.id, entry);
    instances = new Map([...instances].sort((a, b) => b[1].createdAt - a[1].createdAt)); renderInstances();
    await pool([...instances.keys()], async id => {
      try {
        const state = await request(api + 'service-state', { instanceId: id, reconcile: true });
        if (!current(version)) return; states.set(id, state); renderInstances(); await loadUsage(state.instance, version);
      } catch (error) { if (current(version)) { states.set(id, { ...(states.get(id) ?? {}), status: 'unavailable', canUpdate: false, canPreview: false, canDeletePreview: false, canDelete: false, testUrls: [] }); notice(error.message, 'error'); renderInstances(); } }
    });
  } catch (error) { if (current(version)) notice(error.message, 'error'); }
  finally {
    if (current(version)) {
      listBusy = false; clearTimeout(pollTimer);
      if ([...states.values()].some(state => state.status === 'deleting' || ['dispatching', 'dispatched', 'dispatch-unknown', 'running', 'submitting'].includes(state.job?.status ?? state.status))) pollTimer = setTimeout(() => { if (!document.hidden) void refreshInstances(); }, 5000);
    }
  }
}

async function openDeleteService(state, trigger) {
  const version = ++deletionGeneration, pageVersion = generation;
  deletionFocus = trigger; deletionReview = null; deletionSubmitting = false;
  $('service-delete-title').textContent = '删除服务 · ' + (state.instance.environment ?? state.instance.application.name);
  $('service-delete-resources').replaceChildren(); $('service-delete-submit').disabled = true;
  $('service-delete-risk-label').hidden = true; $('service-delete-risk').checked = false;
  $('service-delete-close').disabled = false; $('service-delete-notice').textContent = '正在核对关联资源';
  $('service-delete-dialog').showModal();
  try {
    const result = await request(api + 'delete-plan', { instanceId: state.instance.id, previousTaskId: state.taskId });
    if (version !== deletionGeneration || !current(pageVersion) || !$('service-delete-dialog').open) return;
    deletionReview = result;
    const list = element('dl');
    for (const row of result.plan.resources) list.append(element('dt', ({ worker: 'Worker', domain: '域名', d1: 'D1', kv: 'KV' })[row.kind]), element('dd', `${row.name} · ${row.remoteId} · ${row.accountId}${row.present ? '' : ' · 已不存在'}`));
    $('service-delete-resources').append(list);
    for (const risk of result.plan.unverifiedReferences) $('service-delete-resources').append(element('p', `未核实历史 Pages 引用：${risk.project} · ${risk.kind.toUpperCase()} · ${risk.accountId} · ${risk.deploymentIds.join('、')}`));
    $('service-delete-risk-label').hidden = !result.plan.unverifiedReferences.length;
    $('service-delete-notice').textContent = ''; $('service-delete-submit').disabled = !!result.plan.unverifiedReferences.length;
  } catch { if (version === deletionGeneration && current(pageVersion)) $('service-delete-notice').textContent = '无法核对删除清单，请检查共享绑定、资源变更或连接权限'; }
}
$('service-delete-close').addEventListener('click', () => $('service-delete-dialog').close());
$('service-delete-risk').addEventListener('change', () => { $('service-delete-submit').disabled = !deletionReview || deletionSubmitting || !!deletionReview.plan.unverifiedReferences.length && !$('service-delete-risk').checked; });
$('service-delete-dialog').addEventListener('cancel', event => { if (deletionSubmitting) event.preventDefault(); });
$('service-delete-dialog').addEventListener('close', () => {
  deletionGeneration++; deletionReview = null;
  const key = deletionFocus?.dataset.focusKey;
  (document.querySelector(`[data-focus-key="${CSS.escape(key ?? '')}"]`) ?? $('service-add')).focus();
});
$('service-delete-submit').addEventListener('click', async () => {
  if (!deletionReview || deletionSubmitting || !session) return;
  if (Date.now() >= deletionReview.expiresAt) { deletionReview = null; $('service-delete-submit').disabled = true; $('service-delete-notice').textContent = '确认已过期，请关闭后重新核对'; return; }
  const version = generation; deletionSubmitting = true; $('service-delete-submit').disabled = true; $('service-delete-close').disabled = true;
  $('service-delete-notice').textContent = '正在删除';
  try {
    const result = await request(api + 'delete-submit', { ...deletionReview, acceptUnverifiedReferences: $('service-delete-risk').checked });
    if (!current(version)) return;
    $('service-delete-dialog').close(); notice(result.status === 'deleted' ? '服务及关联数据已删除' : '删除结果未确认，请查看逐项回执', result.status === 'deleted' ? 'success' : 'warning');
  } catch { if (current(version)) { $('service-delete-notice').textContent = '删除请求未确认，请查看实例状态；不要重复提交'; } }
  finally { deletionSubmitting = false; deletionReview = null; $('service-delete-close').disabled = false; if (current(version)) await refreshInstances(); }
});

function renderTabs() {
  const focus = document.activeElement?.dataset.repository;
  const entries = updateTarget ? [...catalog.values()].filter(row => row.repository.toLowerCase() === updateTarget.instance.application.repository.toLowerCase()) : [...catalog.values()];
  entries.sort((left, right) => (catalogOrder.get(left.repository.toLowerCase()) ?? Infinity) - (catalogOrder.get(right.repository.toLowerCase()) ?? Infinity));
  const tabs = entries.map((row, index) => {
    const button = element('button', row.manifest?.name ?? row.repository.split('/').at(-1)); button.type = 'button'; button.role = 'tab'; button.setAttribute('aria-label', (row.manifest?.name ?? row.repository.split('/').at(-1)) + ' · ' + row.repository);
    button.id = 'service-tab-' + index; button.dataset.repository = row.repository; button.tabIndex = selected?.repository === row.repository ? 0 : -1;
    button.setAttribute('aria-selected', String(selected?.repository === row.repository)); button.setAttribute('aria-controls', 'service-edit');
    button.addEventListener('click', () => void selectService(row)); return button;
  });
  $('service-tabs').replaceChildren(...tabs);
  const selectedTab = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
  if (selectedTab) $('service-edit').setAttribute('aria-labelledby', selectedTab.id); else $('service-edit').removeAttribute('aria-labelledby');
  if (!selected && tabs[0]) tabs[0].tabIndex = 0;
  if (focus) $('service-tabs').querySelector(`[data-repository="${CSS.escape(focus)}"]`)?.focus();
  $('service-catalog-status').textContent = scanning ? (scanProgress ? `正在查找服务 · 已检查 ${scanProgress.done}/${scanProgress.total} · 找到 ${catalog.size}${scanErrors.size ? ` · 读取失败 ${scanErrors.size}` : ''}` : '正在读取仓库列表…') : scanErrors.size ? `部分仓库读取失败 · ${[...scanErrors.keys()].join('、')}` : catalog.size ? '' : '未找到含 .sba 的服务';
  controls();
}
async function discoverServices() {
  if (scanning || !session) return;
  const version = generation; scanning = true; scanProgress = null; scanErrors.clear(); loading(1); renderTabs();
  const repositories = new Map();
  try {
  for (const row of connections) if (row.provider === 'github' && (row.state !== 'verified' || row.deploymentAvailable === false)) scanErrors.set(row.name + ' · 连接不可用', true);
  await pool(connections.filter(row => row.provider === 'github' && row.state === 'verified' && row.deploymentAvailable !== false), async row => {
    const github = { id: row.id, revision: row.revision }; let cursor = ''; const seen = new Set();
    try {
      do {
        if (!current(version)) return;
        if (seen.has(cursor) || seen.size >= 250) throw new Error('仓库分页未完成'); seen.add(cursor);
        const page = await request(api + 'catalog', { github, cursor }, 15000); if (!current(version)) return;
        for (const item of page.items) {
          if (!current(version)) return; if (!item.available) continue;
          const key = item.repository.toLowerCase();
          if (!repositories.has(key)) repositories.set(key, []);
          const choices = repositories.get(key);
          if (!choices.some(choice => choice.github.id === github.id)) choices.push({ ...item, github });
        }
        cursor = page.next ?? '';
      } while (cursor);
    } catch { if (current(version)) scanErrors.set(row.name + ' · ' + row.target, true); }
  });
  if (!current(version)) return;
  catalogOrder = new Map([...repositories.keys()].map((key, index) => [key, index]));
  scanProgress = { done: 0, total: repositories.size }; renderTabs();
  // One queue across accounts and pages: a slow earlier repository cannot hide
  // a later service, and duplicate credentials do not multiply concurrent reads.
  await pool([...repositories], async ([key, choices]) => {
    if (!current(version)) return;
    let read = false;
    try {
      for (const item of choices) {
        if (!current(version)) return;
        try {
          const data = await request(api + 'application', { github: item.github, repository: item.repository, sourceSha: null,
            ...(item.defaultBranch ? { defaultBranch: item.defaultBranch } : {}) }, 45000);
          if (!current(version)) return;
          read = true;
          if (data.status !== 'absent') {
            catalog.set(key, data); renderTabs();
            if (!selected && $('service-dialog').open && !updateTarget) void selectService(data);
          }
          if (data.status !== 'invalid') break;
        } catch { if (!current(version)) return; }
      }
      if (!read) scanErrors.set(choices[0].repository, true);
    } finally { if (current(version)) { scanProgress.done++; renderTabs(); } }
  }, 4);
  } finally { if (current(version)) { scanning = false; scannedAt = Date.now(); loading(-1); renderTabs(); } }
}
function addField(container, id, labelText, control) {
  const field = element('div', undefined, 'field'), label = element('label', labelText); label.htmlFor = id; control.id = id;
  field.append(label, control); container.append(field); return control;
}
function fillOptions(select, values, placeholder = null) {
  select.replaceChildren(); if (placeholder !== null) select.append(new Option(placeholder, ''));
  for (const [value, label] of values) select.append(new Option(label, value));
}
function domainFields(data) {
  if (updateTarget || importing || rehearsing || data.declaration.schemaVersion !== 2) return;
  for (const [index, target] of data.declaration.targets.filter(row => row.kind === 'domain').entries()) {
    const field = data.declaration.fields.find(row => row.path.join('.') === target.path.join('.'));
    const select = element('select'), subdomain = element('input');
    select.dataset.domainPath = target.path.join('.'); select.dataset.domainAccount = target.account;
    select.dataset.defaultLabel = field.template === null ? '手动输入' : 'workers.dev';
    select.dataset.fieldIndex = data.declaration.fields.indexOf(field);
    subdomain.maxLength = 63; subdomain.pattern = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    subdomain.value = $('service-environment').value + '-' + (index + 1); subdomain.disabled = true;
    addField($('service-inputs'), 'service-zone-' + index, field.label + ' · 域名', select);
    addField($('service-inputs'), 'service-subdomain-' + index, field.label + ' · 子域名', subdomain);
    select.addEventListener('change', () => syncDomainControl(select, index));
  }
  syncDomainOptions();
}
function syncDomainControl(select, index) {
  const chosen = !!select.value, subdomain = $('service-subdomain-' + index);
  subdomain.disabled = !chosen; subdomain.required = chosen;
  const manual = $('service-field-' + select.dataset.fieldIndex);
  if (manual) manual.disabled = chosen;
}
function syncDomainOptions() {
  for (const [index, select] of [...$('service-inputs').querySelectorAll('[data-domain-path]')].entries()) {
    const account = select.dataset.domainAccount, connectionId = account === 'runtime' ? $('service-cloudflare').value : $('service-account-' + account)?.value;
    const rows = registeredResources.filter(row => row.kind === 'zone' && row.available && row.connectionId === connectionId);
    const previous = select.value || new URLSearchParams(location.hash.slice(1)).get('resource');
    fillOptions(select, rows.map(row => [row.id, row.name]), select.dataset.defaultLabel);
    if (rows.some(row => row.id === previous)) select.value = previous;
    syncDomainControl(select, index);
  }
}
function buildFields(data) {
  adminOverride = null;
  $('service-inputs').replaceChildren(); $('service-resources').replaceChildren();
  if (data.status !== 'ready') return;
  const platform = element('output', 'Cloudflare Workers'); addField($('service-inputs'), 'service-platform', '平台', platform);
  const config = updateTarget?.configuration ?? data.declaration.defaults;
  const automatic = data.declaration.schemaVersion === 2;
  for (const [index, field] of (importing || rehearsing ? [] : data.declaration.fields).entries()) {
    if (automatic && field.template !== null) continue;
    const input = element(field.type === 'json' ? 'textarea' : 'input'), initial = valueAt(config, field.path);
    input.required = field.required; input.value = field.type === 'json' ? JSON.stringify(initial ?? {}, null, 2) : String(initial ?? '');
    if (field.type === 'json') input.rows = 3; else input.maxLength = 8192;
    input.disabled = !!updateTarget; addField($('service-inputs'), 'service-field-' + index, field.label, input);
  }
  fillOptions($('service-cloudflare'), connections.filter(row => row.provider === 'cloudflare' && row.state === 'verified').map(row => [row.id, `${row.name} · ${row.accountName || row.target}`]), '请选择账户');
  const hash = new URLSearchParams(location.hash.slice(1));
  $('service-cloudflare').value = updateTarget?.instance.connections.cloudflare.id ?? hash.get('cloudflare') ?? ($('service-cloudflare').options.length === 2 ? $('service-cloudflare').options[1].value : '');
  $('service-cloudflare').disabled = !!updateTarget; $('service-environment').disabled = !!updateTarget || importing;
  $('service-environment').value = rehearsing ? testEnvironment : updateTarget?.instance.environment ?? (automatic ? 'app-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12) : '');
  $('service-environment').closest('.field').hidden = importing; $('service-config-heading').hidden = importing || automatic;
  $('service-version-label').textContent = importing ? '声明版本' : '版本';
  if (importing) { importFields(data); return; }
  if (automatic) {
    for (const account of data.declaration.accounts.slice(1)) {
      const select = element('select'); select.required = true; select.disabled = !!updateTarget;
      fillOptions(select, connections.filter(row => row.provider === 'cloudflare' && row.state === 'verified').map(row => [row.id, row.accountName || row.name]), '请选择账户');
      select.value = updateTarget?.instance.connections['cloudflare_' + account.key]?.id ?? $('service-cloudflare').value;
      select.addEventListener('change', syncDomainOptions);
      addField($('service-inputs'), 'service-account-' + account.key, account.label, select);
    }
    for (const field of data.declaration.resources) {
      const output = element('output'); output.dataset.resourceTemplate = field.nameTemplate;
      output.value = (rehearsing ? null : updateTarget?.instance.resources[field.key]?.name) ?? field.nameTemplate.replaceAll('{instance}', $('service-environment').value);
      addField($('service-resources'), 'service-resource-' + field.key, field.label + ' · ' + resourceLabels[field.kind], output);
    }
    domainFields(data);
    if(data.declaration.administrator&&!updateTarget&&!rehearsing){
      const select=element('select'),password=element('input'),mode=element('select');
      fillOptions(select,adminProfiles.map(row=>[row.id,row.email]),'不初始化管理员');
      if(adminProfiles.length===1)select.value=adminProfiles[0].id;
      password.type='password';password.autocomplete='new-password';password.minLength=12;password.maxLength=72;
      addField($('service-inputs'),'service-admin-profile','管理员邮箱',select);
      fillOptions(mode,[['default','默认密码'],['override','本次密码']]);
      addField($('service-inputs'),'service-admin-mode','管理员密码',mode);
      addField($('service-inputs'),'service-admin-password','本次密码',password);
      const sync=()=>{adminOverride=null;password.value='';password.placeholder='';mode.disabled=!select.value;password.disabled=!select.value||mode.value!=='override';password.required=!password.disabled;password.closest('.field').hidden=password.disabled;};
      select.addEventListener('change',sync);mode.addEventListener('change',sync);sync();
    }
    return;
  }
  for (const field of data.declaration.resources) {
    const select = element('select'); select.required = true; select.disabled = !!updateTarget;
    fillOptions(select, [], '请选择资源'); addField($('service-resources'), 'service-resource-' + field.key, `${field.label} · ${resourceLabels[field.kind]}`, select);
  }
}
async function loadResources(version, pageVersion) {
  selectedResources = new Map(); selectionBusy = false; const data = application, connectionId = $('service-cloudflare').value;
  if (!connectionId || data?.status !== 'ready') { controls(); return; }
  if (rehearsing || !importing && data.declaration.schemaVersion === 2) { syncDomainOptions(); selectedResources.ready = true; controls(); return; }
  selectionBusy = true; controls();
  try {
    const reference = ref(connectionId), kinds = importing ? ['worker'] : [...new Set(data.declaration.resources.map(row => row.kind))];
    const resources = new Map();
    for (const kind of kinds) {
      let cursor = ''; const items = [], seen = new Set();
      do {
        if (seen.has(cursor) || seen.size >= 250) throw new Error('资源分页未完成'); seen.add(cursor);
        const page = await request('/api/admin/resources', { action: 'inventory', connectionId, kind, cursor });
        if (!currentDialog(version, pageVersion)) return;
        if (page.connectionRevision !== reference.revision) throw new Error('连接已变更，请重新打开弹窗');
        for (const item of page.items) if (!items.some(row => row.id === item.id)) items.push({ ...item, cursor, kind });
        cursor = page.next ?? '';
      } while (cursor);
      resources.set(kind, items);
    }
    if (!currentDialog(version, pageVersion)) return;
    selectedResources = resources; selectedResources.ready = true;
    if (importing) { importWorkerOptions(data, resources.get('worker')); return; }
    for (const field of data.declaration.resources) {
      const select = $('service-resource-' + field.key), rows = resources.get(field.kind);
      fillOptions(select, rows.map(row => [row.id, `${row.name} · ${row.id}`]), rows.length ? '请选择资源' : '无可用资源');
      const previous = updateTarget?.instance.resources[field.key];
      if (previous) { select.value = previous.remoteId; if (!select.value) throw new Error('原绑定资源不可用，更新已禁用'); }
      else if (data.declaration.resources.filter(row => row.kind === field.kind).length === 1) {
        const chosen = registeredResources.find(row => row.id === new URLSearchParams(location.hash.slice(1)).get('resource') && row.connectionId === connectionId && row.kind === field.kind);
        if (chosen && rows.some(row => row.id === chosen.remoteId)) select.value = chosen.remoteId;
      }
    }
    if (!kinds.length) selectedResources.ready = true;
  } catch (error) { if (currentDialog(version, pageVersion)) { selectedResources.ready = false; dialogNotice(error.message, 'error'); } }
  finally { if (currentDialog(version, pageVersion)) { selectionBusy = false; controls(); } }
}
async function loadVersions(row, version, pageVersion) {
  let cursor = ''; const seen = new Set(), hashes = new Set([...$('service-version').options].map(option=>option.value));
  try {
    do {
      if (seen.has(cursor) || seen.size >= 100) throw new Error('版本列表未完整读取'); seen.add(cursor);
      const result = await request(api + 'versions', { github: row.github, repository: row.repository, cursor });
      if (!currentDialog(version, pageVersion)) return;
      for (const item of result.items) if (!hashes.has(item.sourceSha)) { hashes.add(item.sourceSha); $('service-version').append(new Option(`${item.label} · ${item.sourceSha.slice(0, 12)}`, item.sourceSha)); }
      cursor = result.next ?? '';
    } while (cursor);
  } catch (error) { if (currentDialog(version, pageVersion)) dialogNotice(error.message, 'error'); }
}
async function selectService(row) {
  if (busy || submitting) return;
  const version = ++dialogGeneration, pageVersion = generation; selected = row; application = row; clearPreview(); selectedResources = new Map(); selectionBusy = false;
  dialogNotice(row.status === 'ready' ? '' : '此版本的 .sba 声明无效或不受支持', row.status === 'ready' ? 'info' : 'error');
  renderTabs(); $('service-selection').textContent = row.repository + (row.manifest ? ' · v' + row.manifest.version : '');
  fillOptions($('service-version'), [[row.sourceSha, `${row.branch || (row.manifest ? 'v' + row.manifest.version : '当前版本')} · ${row.sourceSha.slice(0, 12)}`]]);
  buildFields(row); controls();
  void loadVersions(row, version, pageVersion);
  await loadResources(version, pageVersion);
}
async function changeVersion() {
  if (!selected || busy || submitting) return;
  const version = ++dialogGeneration, pageVersion = generation, row = selected, sourceSha = $('service-version').value;
  application = null; selectedResources = new Map(); clearPreview(); selectionBusy = true; controls(); dialogNotice('正在读取版本…');
  try {
    const data = await request(api + 'application', { github: row.github, repository: row.repository, sourceSha }); if (!currentDialog(version, pageVersion)) return;
    if (data.status !== 'ready') throw new Error('此版本的 .sba 声明无效或不受支持');
    if (updateTarget && data.manifest.id !== updateTarget.instance.application.id) throw new Error('所选版本不是同一个服务');
    application = data; $('service-selection').textContent = data.repository + ' · v' + data.manifest.version; buildFields(data); dialogNotice('');
    void loadVersions(row, version, pageVersion);
    await loadResources(version, pageVersion);
    if (currentDialog(version,pageVersion) && updateTarget && !newerVersion(data.manifest.version,updateTarget.instance.application.version)) dialogNotice('版本必须高于 v' + updateTarget.instance.application.version,'warning');
    else if (currentDialog(version,pageVersion) && rehearsing && (data.manifest.schemaVersion !== 3 || data.declaration.schemaVersion !== 2)) dialogNotice('此版本未声明预升级测试与清理能力', 'warning');
  } catch (error) { if (currentDialog(version, pageVersion)) dialogNotice(error.message, 'error'); }
  finally { if (currentDialog(version, pageVersion)) { selectionBusy = false; controls(); } }
}
async function openDialog(state = null, trigger = $('service-add'), mode = 'deploy') {
  if (busy || submitting) return;
  importing = mode === 'import';
  rehearsing = mode === 'rehearse'; deletingPreview = false;
  testEnvironment = rehearsing ? 'test-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12) : null;
  updateTarget = state; returnFocus = trigger; selected = null; application = null; selectedResources = new Map(); dialogGeneration++; clearPreview();
  $('service-dialog-title').textContent = state ? (rehearsing ? '预升级测试 · ' : '升级 · ') + state.instance.application.name : importing ? '导入服务' : '部署服务';
  $('service-selection').textContent = ''; $('service-inputs').replaceChildren(); $('service-resources').replaceChildren(); dialogNotice(session ? '' : '身份尚未就绪');
  $('service-dialog').showModal(); $('service-close').focus(); renderTabs();
  if (!session) return;
  if (state) {
    const version = dialogGeneration, pageVersion = generation;
    try {
      const row = { ...state.instance.application, github: ref(state.instance.connections.github.id), status: 'ready' };
      selectionBusy = true; controls();
      const data = await request(api + 'application', { github: row.github, repository: row.repository, sourceSha: row.sourceSha });
      if (!currentDialog(version, pageVersion)) return;
      catalog.set(row.repository.toLowerCase(), data); selectionBusy = false; await selectService(data);
    } catch (error) { if (currentDialog(version, pageVersion)) { selectionBusy = false; dialogNotice(error.message, 'error'); controls(); } }
  } else {
    const stale = !scannedAt || Date.now() - scannedAt > 60000;
    if (stale && !scanning) catalog.clear();
    const hash = new URLSearchParams(location.hash.slice(1)), preferred = connections.find(row => row.id === hash.get('github'));
    const first = [...catalog.values()].find(row => row.github.id === preferred?.id || row.repository === preferred?.target) ?? catalog.values().next().value;
    if (first) await selectService(first);
    // Selecting a default account can await inventory while a scan finishes.
    // Recheck freshness after that await; the earlier stale snapshot is obsolete.
    if ($('service-dialog').open && !scanning && (!scannedAt || Date.now() - scannedAt > 60000)) void discoverServices();
  }
}
async function prepare(event) {
  event.preventDefault(); if (busy || submitting || !application || !session || selectionBusy) return;
  if (preview) { await submit(); return; }
  const version = dialogGeneration, pageVersion = generation, data = application;
  busy = true; controls(); dialogNotice('正在校验部署计划…');
  try {
    if (rehearsing) {
      const result = await request(api + 'plan', { action: 'rehearse', instanceId: updateTarget.instance.id, previousTaskId: updateTarget.taskId, sourceSha: data.sourceSha, environment: testEnvironment });
      if (!currentDialog(version, pageVersion)) return;
      preview = result; const details = element('dl');
      for (const [label, value] of [['源环境', updateTarget.instance.environment], ['当前版本', 'v' + updateTarget.instance.application.version], ['目标版本', `v${data.manifest.version} · ${data.sourceSha}`], ['测试环境', result.plan.policy.environment], ['测试地址', result.plan.operation.context.urls.join('、')], ['独立资源', Object.values(result.plan.resources).map(row => row.name).join('、') || '—']]) details.append(element('dt', label), element('dd', value));
      const risk = element('p', '将复制当前数据到独立测试资源并执行迁移，可能产生云资源费用。线上服务不切换。'); risk.dataset.tone = 'warning';
      $('service-review').replaceChildren(details, risk); dialogNotice(''); return;
    }
    if (importing) {
      dialogNotice('正在读取服务…');
      const result = await request(api + 'import-preview', importDraft(data, ref($('service-cloudflare').value)));
      if (!currentDialog(version, pageVersion)) return;
      preview = result; $('service-review').replaceChildren(...importReview(result.candidate)); dialogNotice(''); return;
    }
    const values = {}, selections = {}, cloudflare = ref($('service-cloudflare').value);
    const automatic = data.declaration.schemaVersion === 2;
    for (const [index, field] of data.declaration.fields.entries()) {
      if (automatic && field.template !== null) continue;
      if (!updateTarget && $('service-field-' + index).disabled) continue;
      const raw = $('service-field-' + index).value; values[field.path.join('.')] = field.type === 'json' ? JSON.parse(raw) : raw;
    }
    const wanted = (automatic ? [] : data.declaration.resources).map(field => {
      const item = selectedResources.get(field.kind)?.find(row => row.id === $('service-resource-' + field.key).value);
      if (!item) throw new Error('请选择全部所需资源'); return { field, item };
    });
    // Only the explicit deploy/update action refreshes and registers the chosen
    // resources. Registration for each page is consumed before another page replaces it.
    const registered = new Map();
    for (const { field, item } of wanted) {
      const key = field.kind + '/' + item.id;
      if (!registered.has(key)) {
        const listing = await request('/api/admin/resources', { action: 'discover', connectionId: cloudflare.id, kind: field.kind, cursor: item.cursor });
        if (!currentDialog(version, pageVersion)) return;
        const response = await request('/api/admin/resources', { action: 'register', connectionId: cloudflare.id, kind: field.kind, listingId: listing.id, resourceId: item.id });
        if (!currentDialog(version, pageVersion)) return;
        registered.set(key, { id: response.resource.id, revision: response.resource.revision });
      }
      selections[field.key] = registered.get(key);
    }
    const accounts = automatic ? Object.fromEntries(data.declaration.accounts.slice(1).map(account => [account.key, ref($('service-account-' + account.key).value)])) : null;
    const domains = {};
    for (const [index, select] of [...$('service-inputs').querySelectorAll('[data-domain-path]')].entries()) if (select.value) {
      const zone = registeredResources.find(row => row.id === select.value && row.kind === 'zone' && row.available);
      if (!zone) throw new Error('所选域名不可用');
      domains[select.dataset.domainPath] = { resource: { id: zone.id, revision: zone.revision }, subdomain: $('service-subdomain-' + index).value.trim() };
    }
    let administrator;
    if($('service-admin-profile')?.value){
      const profile=adminProfiles.find(row=>row.id===$('service-admin-profile').value);if(!profile)throw new Error('管理员邮箱不可用');
      administrator={profile:{id:profile.id,revision:profile.revision}};
      const password=$('service-admin-password');
      if($('service-admin-mode').value==='override'&&password.value){
        const secretInput={action:'admin-override',id:crypto.randomUUID(),profile:administrator.profile,password:password.value};password.value='';
        let result;try{result=await request('/api/admin/resources',secretInput);}finally{secretInput.password=undefined;}
        if(!currentDialog(version,pageVersion))return;
        adminOverride={id:result.profile.id,revision:result.profile.revision};
        password.required=false;password.placeholder='已设置';
      }
      if($('service-admin-mode').value==='override'){if(!adminOverride)throw new Error('请输入本次管理员密码');administrator.override=adminOverride;}
    }
    const body = { action: 'preview', github: data.github, repository: data.repository, sourceSha: data.sourceSha, cloudflare,
      environment: $('service-environment').value, values, resources: selections,
      ...(accounts ? { accounts } : {}),
      ...(Object.keys(domains).length ? { domains } : {}),
      ...(administrator ? { administrator } : {}),
      ...(updateTarget ? { instance: { id: updateTarget.instance.id, previousTaskId: updateTarget.taskId } } : {}) };
    const result = await request(api + 'plan', body); if (!currentDialog(version, pageVersion)) return; preview = result;
    const details = element('dl');
    const plan = result.plan;
    if(administrator)details.append(element('dt','管理员邮箱'),element('dd',adminProfiles.find(row=>row.id===administrator.profile.id).email),element('dt','管理员密码'),element('dd',administrator.override?'本次配置':'已保存的默认密码'));
    for (const [label, value] of [['服务', plan.application.manifest.name], ['版本', `v${plan.application.manifest.version} · ${plan.application.sourceSha}`], ['环境', plan.policy.environment], ['账户', connections.find(row => row.id === cloudflare.id)?.accountName ?? connections.find(row => row.id === cloudflare.id)?.target], ['绑定资源', Object.values(plan.resources).map(row => `${resourceLabels[row.kind]} · ${row.name}`).join('、') || '—']]) details.append(element('dt', label), element('dd', value));
    if (automatic) {
      for (const account of data.declaration.accounts.slice(1)) details.append(element('dt', account.label), element('dd', plan.accounts[account.key].accountId));
      for (const field of data.declaration.fields) { const value = valueAt(plan.configuration, field.path); details.append(element('dt', field.label), element('dd', typeof value === 'string' ? value : JSON.stringify(value))); }
    }
    const risk = element('p', result.executionEnabled ? updateTarget ? '将保留原资源，对当前线上数据执行该版本的备份和迁移，不使用测试数据覆盖。' : '将运行所选代码并修改目标云资源。' : '部署执行未启用'); risk.dataset.tone = 'warning';
    $('service-review').replaceChildren(details, risk); dialogNotice('');
  } catch (error) { if (currentDialog(version, pageVersion)) dialogNotice(error instanceof SyntaxError ? 'JSON 配置格式不正确' : error.message, 'error'); }
  finally { if (currentDialog(version, pageVersion)) { busy = false; controls(); if (preview) $('service-back').focus(); } }
}
async function submit() {
  if (importing) { await submitImport(); return; }
  if (!preview?.executionEnabled || submitting) return;
  const saved = preview, version = generation, instanceId = saved.plan.operation?.instanceId ?? saved.taskId;
  preview = null; submitting = true; controls(); dialogNotice('正在提交…');
  const plan = saved.plan;
  const summary = { id: instanceId, action: plan.operation?.action ?? 'deploy', previous: plan.operation?.previous ?? null,
    application: { id: plan.application.manifest.id, name: plan.application.manifest.name, version: plan.application.manifest.version, repository: plan.application.repository, sourceSha: plan.application.sourceSha },
    environment: plan.policy.environment, connections: plan.connections, resources: plan.resources, targets: [], accountId: connections.find(row => row.id === plan.connections.cloudflare.id)?.target, ...(plan.previewOf ? { previewOf: plan.previewOf } : {}) };
  instances.set(instanceId, { id: instanceId, taskId: saved.taskId, createdAt: Date.now(), summary });
  states.set(instanceId, { instance: summary, status: 'submitting', canUpdate: false }); renderInstances();
  try {
    const { executionEnabled: _, ...body } = saved;
    const result = await request(api + 'submit', body); if (!current(version)) return;
    states.set(instanceId, { ...result, instance: summary, canUpdate: false });
    submitting = false; $('service-dialog').close(); notice(''); void refreshInstances();
  } catch {
    if (current(version)) {
      states.set(instanceId, { instance: summary, taskId: saved.taskId, status: 'preparation-unconfirmed', canUpdate: false });
      dialogNotice('提交未确认，请查看该实例状态；不要新建任务重试。', 'error'); notice('任务 ' + saved.taskId + ' 提交未确认', 'error');
      void refreshInstances();
    }
  } finally { if (current(version)) { submitting = false; application = null; renderInstances(); controls(); } }
}
async function submitImport() {
  if (!preview || submitting) return;
  const saved = preview, version = generation;
  preview = null; submitting = true; controls(); dialogNotice('正在导入…');
  try {
    await request(api + 'import-submit', saved); if (!current(version)) return;
    submitting = false; $('service-dialog').close(); notice(''); await refreshInstances();
  } catch (error) {
    if (current(version)) { dialogNotice(error.message, 'error'); void refreshInstances(); }
  } finally { if (current(version)) { submitting = false; controls(); } }
}

async function openDeletePreview(state, trigger) {
  if (busy || submitting || !session || !state.canDeletePreview) return;
  importing = false; rehearsing = false; deletingPreview = true; updateTarget = state; returnFocus = trigger;
  application = { status: 'ready' }; selected = null; preview = null; selectedResources = new Map(); selectedResources.ready = true;
  const version = ++dialogGeneration, pageVersion = generation; busy = true;
  $('service-dialog-title').textContent = '删除测试环境 · ' + state.instance.environment;
  $('service-tabs').replaceChildren(); $('service-catalog-status').textContent = ''; $('service-inputs').replaceChildren(); $('service-resources').replaceChildren(); $('service-review').replaceChildren();
  $('service-dialog').showModal(); controls(); $('service-close').focus(); dialogNotice('正在核对资源归属…');
  try {
    const result = await request(api + 'plan', { action: 'destroy-preview', instanceId: state.instance.id, previousTaskId: state.taskId });
    if (!currentDialog(version, pageVersion)) return;
    preview = result; const list = element('ul');
    for (const row of result.plan.operation.context.resources) list.append(element('li', `${row.kind} · ${row.name} · ${row.accountId}`));
    const risk = element('p', '将永久删除以上测试资源及其中的数据，不删除原线上环境。'); risk.dataset.tone = 'warning';
    $('service-review').replaceChildren(list, risk); dialogNotice('');
  } catch (error) { if (currentDialog(version, pageVersion)) { application = null; dialogNotice(error.message, 'error'); } }
  finally { if (currentDialog(version, pageVersion)) { busy = false; controls(); $('service-close').focus(); } }
}

$('service-add').addEventListener('click', () => void openDialog());
$('service-import').addEventListener('click', () => void openDialog(null, $('service-import'), 'import'));
$('service-close').addEventListener('click', () => $('service-dialog').close());
$('service-dialog').addEventListener('close', () => { dialogGeneration++; busy = false; selectionBusy = false; preview = null; application = null; selected = null; controls(); restoreFocus(); });
$('service-form').addEventListener('submit', event => void prepare(event));
$('service-back').addEventListener('click', clearPreview);
$('service-version').addEventListener('change', () => void changeVersion());
$('service-cloudflare').addEventListener('change', () => { clearPreview(); dialogNotice(''); void loadResources(++dialogGeneration, generation); });
$('service-fields').addEventListener('input', () => {
  if (preview) clearPreview();
  if (!updateTarget) for (const output of document.querySelectorAll('output[data-resource-template]')) output.value = output.dataset.resourceTemplate.replaceAll('{instance}', $('service-environment').value);
});
$('service-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy || submitting) return;
  const tabs = [...$('service-tabs').children], index = tabs.indexOf(document.activeElement); if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  const repository = tabs[next].dataset.repository; tabs[next].click();
  const target = $('service-tabs').querySelector(`[data-repository="${CSS.escape(repository)}"]`);
  target?.focus(); target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
async function initialize() {
  invalidate(); listBusy = false; scanning = false; scannedAt = 0;
  const version = generation; loading(1); notice('');
  try {
    const auth = await request('/api/admin/state'); if (!current(version)) return; session = auth;
    const result = await request('/api/admin/connections'); if (!current(version)) return; connections = result.connections;
    const resources = await request('/api/admin/resources'); if (!current(version)) return; registeredResources = resources.resources; adminProfiles = resources.adminProfiles??[];
    await refreshInstances(); if (!current(version)) return; controls();
    if (location.hash || $('service-dialog').open) await openDialog();
  } catch (error) { if (current(version)) { invalidate(); notice(error.message, 'error'); } }
  finally { if (current(version)) loading(-1); }
}
addEventListener('pagehide', invalidate); addEventListener('pageshow', event => { if (event.persisted) void initialize(); });
addEventListener('visibilitychange', () => { if (!document.hidden && session && !$('service-dialog').open) void refreshInstances(); });
void initialize();
