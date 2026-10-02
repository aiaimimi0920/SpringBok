import { createHash } from 'node:crypto';
import { openJournal } from '../execution/journal.mjs';
import { NODE, exact, submission, report } from '../../cloud/protocol.mjs';
export function nodeClient(origin, token, { fetcher = fetch } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || !/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid bridge configuration');
  return Object.freeze({ async call(path, value) {
    if (!['/node/poll', '/node/report'].includes(path)) throw new Error('unsupported bridge route');
    const response = await fetcher(origin + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('control unavailable'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const { done, value: bytes } = await reader.read(); if (done) break; size += bytes.length; if (size > 16384) throw new Error('large control response'); chunks.push(bytes); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  } });
}
function project(events) {
  const jobs = new Map();
  for (const [index, event] of events.entries()) {
    if (event.revision !== index + 1) throw new Error('invalid bridge sequence');
    if (event.kind === 'started') {
      exact(event, ['revision', 'kind', 'input']); const input = submission(event.input);
      if (jobs.has(input.id) || [...jobs.values()].some(j => !j.ack)) throw new Error('duplicate bridge dispatch');
      jobs.set(input.id, { input, receipt: null, ack: false });
    } else if (event.kind === 'result') {
      exact(event, ['revision', 'kind', 'receipt']); const receipt = report(event.receipt), job = jobs.get(receipt.id);
      if (!job || job.receipt || job.input.challenge !== receipt.challenge) throw new Error('invalid bridge receipt'); job.receipt = receipt;
    } else if (event.kind === 'ack') {
      exact(event, ['revision', 'kind', 'id', 'status']); const job = jobs.get(event.id);
      if (!job?.receipt || job.ack || !['observed', 'unknown'].includes(event.status) || (job.receipt.outcome === 'unknown' && event.status !== 'unknown')) throw new Error('invalid bridge ack');
      job.ack = true;
    } else throw new Error('invalid bridge event');
  }
  return jobs;
}
// This entry only observes a protocol challenge. It has no Docker/Komodo/shell
// adapter and cannot perform deployment, acceptance, promotion or rollback.
export function openProbeBridge({ directory, origin, token, fetcher, observe = async () => {} }) {
  const client = nodeClient(origin, token, { fetcher });
  const binding = createHash('sha256').update(`protocol-probe/v1/${NODE}/${origin}`).digest('hex');
  const journal = openJournal(directory, binding, project);
  try {
    for (const job of project(journal.read()).values()) if (!job.receipt) journal.append({ kind: 'result', receipt: { id: job.input.id, challenge: job.input.challenge, outcome: 'unknown' } });
  } catch (error) { journal.close(); throw error; }
  let busy = false;
  async function deliver(receipt) {
    const result = await client.call('/node/report', receipt); exact(result, ['status', 'id']);
    if (result.id !== receipt.id || !['observed', 'unknown'].includes(result.status) || (receipt.outcome === 'unknown' && result.status !== 'unknown')) throw new Error('invalid control acknowledgement');
    journal.append({ kind: 'ack', id: receipt.id, status: result.status }); return result.status;
  }
  return {
    snapshot: () => journal.read(), close: () => { if (busy) throw new Error('bridge is busy'); journal.close(); },
    async step() {
      if (busy) throw new Error('bridge is busy'); busy = true;
      try {
        const pending = [...project(journal.read()).values()].find(j => !j.ack);
        if (pending) return await deliver(pending.receipt);
        const response = await client.call('/node/poll', { node: NODE });
        if (response.status !== 'delivery') {
          exact(response, response.status === 'idle' ? ['status'] : ['status', 'id']);
          if (!['idle', 'claimed', 'unknown', 'expired'].includes(response.status) || (response.status !== 'idle' && (typeof response.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(response.id)))) throw new Error('invalid control status');
          return response.status;
        }
        exact(response, ['status', 'input']); const input = submission(response.input);
        if (project(journal.read()).has(input.id)) throw new Error('duplicate delivery');
        journal.append({ kind: 'started', input });
        let outcome = 'unknown'; try { await observe(structuredClone(input)); outcome = 'observed'; } catch { /* An uncertain observation must not be retried. */ }
        const receipt = { id: input.id, challenge: input.challenge, outcome };
        journal.append({ kind: 'result', receipt });
        return await deliver(receipt);
      } finally { busy = false; }
    },
  };
}
