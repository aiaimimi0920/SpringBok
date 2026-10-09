import { aggregateMetrics, brandName, formatAmount, resourceCount, resourceKinds, resourceLabels } from './resource-model.mjs';
import { decorateIcons } from './shell.js';

export const textNode = (tag, text, className) => {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className; return node;
};
const icon = kind => ({ worker: 'deploy', d1: 'database', kv: 'keyvalue', r2: 'bucket', zone: 'cloud', repository: 'github' })[kind];
function metricsBlock(metrics, compact = false) {
  const block = document.createElement('span'); block.className = 'usage-metrics';
  for (const metric of metrics) {
    const row = document.createElement('span'); row.className = 'usage-metric'; row.dataset.metric = metric.kind + '/' + metric.id;
    row.dataset.period = metric.period;
    const title = textNode('span', (compact ? resourceLabels[metric.kind] + ' · ' : '') + metric.label, 'usage-label');
    title.append(textNode('small', metric.periodLabel));
    const amount = textNode('span', (metric.value !== null && !metric.complete ? '≥ ' : '') + formatAmount(metric.value, metric.unit) + ' / ' +
      (metric.allowance !== null && !metric.quotaComplete ? '≥ ' : '') + formatAmount(metric.allowance, metric.unit), 'usage-amount');
    const tags = [];
    if (metric.scopes.some(scope => scope.source === 'manual')) tags.push('手工规划');
    else if (metric.allowance !== null) tags.push('标准套餐');
    else tags.push('额度未知');
    if (metric.estimated) tags.push('估算');
    if (!metric.complete) tags.push('用量不完整');
    amount.append(textNode('small', tags.join(' · ')));
    const track = document.createElement('span'); track.className = 'usage-track';
    if (metric.ratio !== null) {
      track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', title.textContent);
      track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(metric.ratio * 1000) / 10));
      track.setAttribute('aria-valuetext', amount.textContent);
      const fill = document.createElement('span'); fill.style.width = metric.ratio * 100 + '%'; track.append(fill);
    } else { track.dataset.unknown = 'true'; track.setAttribute('aria-hidden', 'true'); }
    const rest = textNode('span', '剩余 ' + formatAmount(metric.remaining, metric.unit), 'usage-remaining');
    if (metric.excess > 0) {
      row.dataset.over = 'true'; rest.append(textNode('small', '超出 ' + (!metric.excessComplete ? '≥ ' : '') + formatAmount(metric.excess, metric.unit) +
        (metric.overAccounts > 1 ? ` · ${metric.overAccounts} 个账户` : ''), 'usage-over'));
    }
    row.append(title, amount, track, rest); block.append(row);
  }
  return block;
}
export function createResourceTree(host, handlers) {
  const opened = new Map(), statsOpened = new Map(); let view = 'account';
  function node(key, title, metrics, { level = 0, count = 0, symbol, open = false, status = '', className = '' } = {}) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.className = 'resource-node ' + className; details.dataset.nodeKey = key;
    details.open = opened.has(view + '/' + key) ? opened.get(view + '/' + key) : open;
    const capturedView = view;
    details.addEventListener('toggle', () => { if (details.isConnected && capturedView === view) opened.set(view + '/' + key, details.open); });
    const label = textNode('span', '', 'tree-label'), heading = textNode(level === 0 ? 'h2' : 'h3', title, 'tree-name');
    if (symbol) heading.dataset.icon = symbol;
    label.append(heading, textNode('span', count + ' 项', 'tree-count'));
    if (status) label.append(textNode('span', status, 'inventory-status'));
    summary.append(label);
    if (metrics.length) {
      const stats = metricsBlock(metrics, level < 2), toggle = textNode('button', '', 'resource-stats-toggle');
      const stateKey = view + '/' + key;
      stats.id = 'usage-' + encodeURIComponent(stateKey); stats.hidden = !statsOpened.get(stateKey);
      toggle.type = 'button'; toggle.dataset.stats = 'true'; toggle.setAttribute('aria-controls', stats.id);
      const update = () => {
        toggle.textContent = stats.hidden ? '展开统计' : '收起统计';
        toggle.setAttribute('aria-expanded', String(!stats.hidden));
        toggle.setAttribute('aria-label', title + ' · ' + toggle.textContent);
      };
      update();
      toggle.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        stats.hidden = !stats.hidden; statsOpened.set(stateKey, !stats.hidden); update();
      });
      // Reading or selecting metric text must not toggle the resource branch.
      stats.addEventListener('click', event => event.preventDefault());
      summary.append(toggle, stats);
    }
    const children = document.createElement('div'); children.className = 'resource-children';
    details.append(summary, children); return { details, children };
  }
  function group(group, resourceView) {
    const { details, children } = node(group.key, resourceView ? brandName(group.account.provider) + ' · ' + group.account.name : resourceLabels[group.kind], group.metrics,
      { level: 2, count: group.items.length, symbol: resourceView ? group.account.provider : icon(group.kind),
        status: [group.status, group.usageStatus].filter(Boolean).join(' · '), className: 'inventory-group' });
    details.dataset.kind = group.kind; details.dataset.account = group.account.target;
    if (!group.complete && !group.sources.some(source => source.status === 'loading')) details.querySelector('.inventory-status')?.setAttribute('data-tone', 'error');
    const actions = document.createElement('div'); actions.className = 'resource-group-actions';
    if (group.kind === 'r2') actions.append(textNode('span', '默认管辖区', 'inventory-status'));
    if (group.readySource && ['d1', 'kv', 'r2'].includes(group.kind)) {
      const button = textNode('button', '规划容量'); button.type = 'button'; button.dataset.budget = 'true';
      button.addEventListener('click', () => handlers.budget(group, button)); actions.append(button);
    }
    if (actions.childNodes.length) children.append(actions);
    const list = document.createElement('ul'); list.className = 'resource-instances';
    for (const entry of group.items) {
      const { item, source } = entry, li = document.createElement('li'); li.dataset.id = item.id;
      const name = textNode('button', item.name, 'resource-instance-name'); name.type = 'button'; name.dataset.detail = item.id;
      name.addEventListener('click', () => handlers.detail(group, entry, name));
      const identity = document.createElement('div'); identity.className = 'instance-identity'; identity.append(name);
      if (item.name !== item.id) identity.append(textNode('small', item.id));
      const values = document.createElement('div'); values.className = 'instance-usage';
      for (const metric of entry.metrics ?? []) values.append(textNode('span', metric.label + '  ' +
        (metric.value !== null && !metric.complete ? '≥ ' : '') + formatAmount(metric.value, metric.unit) + (metric.estimated ? ' · 估算' : '')));
      li.append(identity, values);
      if (group.kind !== 'worker' && item.available !== false && source.row.state === 'verified') {
        const button = textNode('button', '用于部署'); button.type = 'button'; button.dataset.use = 'true';
        button.addEventListener('click', () => handlers.use(source.row, group.kind, item, item.cursor, button)); li.append(button);
      } else li.append(textNode('small', group.kind === 'worker' ? '只读' : item.reason === 'unsupported-name' ? '不支持的仓库名称' : '已归档或停用'));
      list.append(li);
    }
    children.append(list);
    if (!group.items.length && group.complete) children.append(textNode('p', '暂无可读取资源', 'empty-state'));
    for (const source of group.more) {
      const button = textNode('button', '加载更多'); button.type = 'button'; button.dataset.more = 'true';
      button.addEventListener('click', () => handlers.more(source, button)); children.append(button);
    }
    return details;
  }
  return {
    clear() { opened.clear(); statsOpened.clear(); host.replaceChildren(); },
    render(accounts, currentView) {
      const focused = document.activeElement;
      const focusNode = host.contains(focused) ? focused.closest('details[data-node-key]') : null;
      const focusKey = focusNode?.dataset.nodeKey, focusItem = focused?.closest('li')?.dataset.id;
      const focusRole = focused?.tagName === 'SUMMARY' ? 'summary' : focused?.hasAttribute('data-stats') ? 'stats' : focused?.hasAttribute('data-detail') ? 'detail' :
        focused?.hasAttribute('data-use') ? 'use' : focused?.hasAttribute('data-budget') ? 'budget' : null;
      view = currentView;
      // Capture native open state before replacing nodes; queued toggle events are not authoritative.
      for (const node of host.querySelectorAll('details[data-node-key]')) {
        if (host.dataset.view) opened.set(host.dataset.view + '/' + node.dataset.nodeKey, node.open);
      }
      const fragment = document.createDocumentFragment();
      if (!accounts.length) fragment.append(textNode('p', '暂无云账户', 'empty-state'));
      if (view === 'account') {
        for (const provider of ['cloudflare', 'github']) {
          const rows = accounts.filter(account => account.provider === provider); if (!rows.length) continue;
          const groups = rows.flatMap(account => account.groups);
          const brand = node('brand/' + provider, brandName(provider), aggregateMetrics(groups.flatMap(group => group.metrics)),
            { symbol: provider, count: resourceCount(groups), open: true });
          for (const account of rows) {
            const accountNode = node(account.key, brandName(provider) + ' · ' + account.name, account.metrics,
              { level: 1, count: account.count, open: true });
            accountNode.details.dataset.account = account.target;
            accountNode.details.querySelector('.tree-label').append(textNode('span', account.note, 'tree-count'));
            accountNode.children.append(textNode('p', account.target, 'account-target'));
            for (const item of account.groups) accountNode.children.append(group(item, false));
            brand.children.append(accountNode.details);
          }
          fragment.append(brand.details);
        }
      } else {
        for (const kind of resourceKinds) {
          const groups = accounts.flatMap(account => account.groups.filter(group => group.kind === kind)); if (!groups.length) continue;
          const root = node('kind/' + kind, resourceLabels[kind], aggregateMetrics(groups.flatMap(group => group.metrics)),
            { count: resourceCount(groups), symbol: icon(kind), status: groups.some(group => !group.complete) ? '列表不完整' : '' });
          root.details.dataset.resourceKind = kind;
          for (const item of groups) root.children.append(group(item, true));
          fragment.append(root.details);
        }
      }
      host.replaceChildren(fragment); host.dataset.view = view; decorateIcons(host);
      if (focusKey && focusRole) {
        const node = host.querySelector(`[data-node-key="${CSS.escape(focusKey)}"]`);
        const target = focusRole === 'summary' ? node?.querySelector(':scope > summary') : focusRole === 'stats' ? node?.querySelector(':scope > summary [data-stats]') : focusItem ?
          node?.querySelector(`li[data-id="${CSS.escape(focusItem)}"] [data-${focusRole}]`) : node?.querySelector('[data-budget]');
        target?.focus({ preventScroll: true });
      }
    },
  };
}

export function renderResourceDetail(host, group, entry) {
  host.replaceChildren();
  const rows = [['品牌', brandName(group.account.provider)], ['账户', group.account.name], ['Account ID', group.account.target], ['资源 ID', entry.item.id]];
  for (const [key, value] of rows) { host.append(textNode('dt', key), textNode('dd', value)); }
  for (const metric of entry.metrics ?? []) {
    host.append(textNode('dt', metric.label + (metric.estimated ? ' · 估算' : '')),
      textNode('dd', (metric.value !== null && !metric.complete ? '≥ ' : '') + formatAmount(metric.value, metric.unit)),
      textNode('dt', '计量时间'), textNode('dd', metric.observedAt || '—'));
    if (metric.allowance) host.append(textNode('dt', '账户共享套餐额度'), textNode('dd', formatAmount(metric.allowance.value, metric.unit)),
      textNode('dt', '套餐'), textNode('dd', metric.allowance.plan), textNode('dt', '额度规则日期'), textNode('dd', metric.allowance.reviewedAt));
  }
  if (group.budget.value !== null) host.append(textNode('dt', '账户共享规划容量'), textNode('dd', formatAmount(group.budget.value, 'bytes')));
}
