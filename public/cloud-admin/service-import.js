import { resourceLabels } from './resource-model.mjs';
import { valueAt } from './service-model.mjs';

const $ = id => document.getElementById(id);
const node = (tag, text) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const components = data => data.declaration.targets.filter(row => row.kind === 'worker');
export function importFields(data) {
  for (const [index, component] of components(data).entries()) {
    const row = node('div'), label = node('label', component.path.slice(0, -1).join('.') || 'Worker'), select = node('select');
    row.className = 'field'; select.id = 'service-import-worker-' + index; select.required = true; label.htmlFor = select.id;
    select.append(new Option('请选择 Worker', '')); row.append(label, select); $('service-inputs').append(row);
  }
}
export function importWorkerOptions(data, items) {
  const used = new Set();
  for (const [index, component] of components(data).entries()) {
    const select = $('service-import-worker-' + index);
    select.replaceChildren(new Option(items.length ? '请选择 Worker' : '无可用 Worker', ''));
    for (const item of items) select.append(new Option(item.name, item.id));
    const declared = valueAt(data.declaration.defaults, component.path);
    const chosen = items.find(item => item.id === declared && !used.has(item.id)) ?? (components(data).length === 1 && items.length === 1 ? items[0] : null);
    if (chosen) { select.value = chosen.id; used.add(chosen.id); }
  }
}
export function importDraft(data, cloudflare) {
  return { github: data.github, repository: data.repository, sourceSha: data.sourceSha, cloudflare,
    components: Object.fromEntries(components(data).map((component, index) => [component.path.join('.'), $('service-import-worker-' + index).value])) };
}
export function importedDetails(state) {
  const list = node('dl');
  const field = (label, value) => list.append(node('dt', label), node('dd', value ?? '—'));
  field('部署版本', '未知');
  field('声明来源', state.definition?.sourceSha);
  if (state.observedAt) field('读取时间', new Date(state.observedAt).toLocaleString());
  for (const component of state.components ?? []) {
    field(component.label, component.name);
    for (const domain of component.domains) {
      const link = node('a', domain); link.href = domain; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const value = node('dd'); value.append(link); list.append(node('dt', '地址'), value);
    }
  }
  for (const resource of Object.values(state.instance.resources)) {
    field(resourceLabels[resource.kind], resource.name);
    field('资源 ID', resource.remoteId);
    field('绑定', resource.bindings.map(row => row.worker + ' / ' + row.binding).join(' · '));
  }
  if (state.provenance?.type === 'legacy-task') {
    field('原任务', state.provenance.taskId);
    field('原任务版本', `v${state.provenance.applicationVersion} · ${state.provenance.sourceSha}`);
    field('原任务状态', state.provenance.status);
    field('原错误代码', state.provenance.result?.errorCode);
  }
  return list;
}
export function importReview(candidate) {
  const title = node('h3', candidate.instance.application.name), details = importedDetails(candidate), risk = node('p', '仅登记现有服务，不重新部署。');
  return [title, details, risk];
}
