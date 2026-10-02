// Presentation only: input is an already validated snapshot, never a command.
export const serviceIds = Object.freeze(['gateway', 'forum', 'game', 'account']);
export function historyRows(snapshot) {
  const requests = new Map(), preparations = new Map(), starts = new Map();
  const eventsById = new Map();
  const fields = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));
  function indexEvent(event, source) {
    const ids = new Set([event.input?.id || event.requestId, ...(event.invalidated || [])].filter(Boolean));
    for (const id of ids) {
      if (!eventsById.has(id)) eventsById.set(id, { preparation: [], execution: [] });
      eventsById.get(id)[source].push(eventRow(event, source));
    }
  }
  const valid = input => input && typeof input.id === 'string' && serviceIds.includes(input.service);
  for (const request of snapshot.requests) {
    if (!valid(request.input) || requests.has(request.input.id)) throw new Error('ambiguous request');
    requests.set(request.input.id, request);
  }
  for (const event of snapshot.history) {
    indexEvent(event, 'execution');
    if (event.input) {
    if (!valid(event.input) || starts.has(event.input.id)) throw new Error('ambiguous execution history');
    starts.set(event.input.id, event);
    }
  }
  for (const event of snapshot.preparationHistory) {
    indexEvent(event, 'preparation');
    if (event.kind === 'prepare') {
    if (!valid(event.input) || preparations.has(event.input.id)) throw new Error('ambiguous preparation');
    preparations.set(event.input.id, event);
    }
  }
  const ids = new Set([...requests.keys(), ...starts.keys(), ...preparations.keys()]);
  const rows = [];
  for (const id of ids) {
    const request = requests.get(id), start = starts.get(id), preparation = preparations.get(id);
    const input = request?.input || start?.input || preparation.input;
    for (const other of [start, preparation]) if (other &&
      (other.input.service !== input.service || other.input.operation !== input.operation || fields(other.input.params || {}) !== fields(input.params || {}))) throw new Error('cross-scope request');
    const plans = [request?.plan, start?.plan, preparation?.plan].filter(Boolean);
    if (new Set(plans.map(fields)).size > 1) throw new Error('cross-plan request');
    const plan = start?.plan || preparation?.plan;
    const status = start && request ? request.status : 'unknown';
    const indexed = eventsById.get(id);
    const events = indexed ? [...indexed.preparation, ...indexed.execution] : [];
    rows.push({ id, service: input.service, operation: input.operation, status,
      source: start ? 'execution' : 'preparation', revision: start?.revision || preparation?.revision || 0,
      target: plan?.target || null, artifact: plan?.artifact || null, updateId: request?.updateId || null, events });
  }
  // Separate journals have separate sequences. Preparation-only rows come first;
  // their revision must never be compared to execution revisions as a timestamp.
  return rows.sort((a, b) => (a.source === b.source ? b.revision - a.revision : a.source === 'preparation' ? -1 : 1) || a.id.localeCompare(b.id, 'en'));
}
export function eventRow(event, source) {
  return { source, revision: event.revision, kind: event.kind,
    requestId: event.input?.id || event.requestId || null,
    updateId: event.updateId || event.evidence?.updateId || null };
}
export function pageRows(rows, service = 'all', requestedPage = 1) {
  if (service !== 'all' && !serviceIds.includes(service)) throw new Error('unknown service filter');
  const filtered = service === 'all' ? rows : rows.filter(row => row.service === service);
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const page = Math.max(1, Math.min(pages, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  return { page, pages, total: filtered.length, rows: filtered.slice((page - 1) * 10, page * 10) };
}
