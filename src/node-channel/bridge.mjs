import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal } from '../execution/journal.mjs';
import { exact } from '../../cloud/protocol.mjs';
import { nodePlan, probeReceipt, MAX_NODE_JOBS } from '../../cloud/node-protocol.mjs';
import { requireCredential } from '../../cloud/credential-contract.mjs';
import { isUuid } from '../../cloud/catalog-contract.mjs';
import { openNodeChannelClient } from './client.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function verifiedPlan(value, context) {
  const input = nodePlan(value, { ownerId: context.ownerId, nodeId: context.nodeId }), { planDigest, ...fields } = input;
  requireCredential(planDigest === `sha256:${hash(fields)}`); return input;
}
function project(events, context) {
  const jobs = new Map(); let blocked = false;
  for (const [index, event] of events.entries()) {
    requireCredential(event.revision === index + 1);
    requireCredential(!blocked);
    if (event.kind === 'started') {
      exact(event, ['revision', 'kind', 'input']); const input = verifiedPlan(event.input, context);
      requireCredential(jobs.size < MAX_NODE_JOBS && !jobs.has(input.requestId) && ![...jobs.values()].some(job => !job.ack || job.receipt.outcome === 'unknown' || job.ack.status === 'unknown'));
      jobs.set(input.requestId, { input, receipt: null, ack: null });
    } else if (event.kind === 'result') {
      exact(event, ['revision', 'kind', 'receipt']); const receipt = probeReceipt(event.receipt), job = jobs.get(receipt.requestId);
      requireCredential(job && !job.receipt && job.input.planDigest === receipt.planDigest && job.input.challenge === receipt.challenge); job.receipt = receipt;
    } else if (event.kind === 'remote-unknown') {
      exact(event, ['revision', 'kind', 'requestId']);
      requireCredential(isUuid(event.requestId) && [...jobs.values()].every(job => job.ack)); blocked = true;
    } else {
      exact(event, ['revision', 'kind', 'requestId', 'status']); const job = jobs.get(event.requestId);
      requireCredential(event.kind === 'ack' && job?.receipt && !job.ack && ['observed', 'unknown'].includes(event.status) && (event.status === 'unknown' || event.status === job.receipt.outcome));
      job.ack = { status: event.status };
    }
  }
  return { jobs, blocked };
}
function privateDirectory(directory) {
  requireCredential(process.platform === 'linux'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory); requireCredential(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  try { const file = lstatSync(join(directory, 'ledger.json')); requireCredential(file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid() && (file.mode & 0o077) === 0); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function openNodeChannelBridge({ directory, ...options }) {
  const client = openNodeChannelClient(options), context = client.context; privateDirectory(directory);
  const journal = openJournal(directory, hash(['node-channel/v2', context]), events => project(events, context));
  try {
    for (const job of project(journal.read(), context).jobs.values()) if (!job.receipt) journal.append({ kind: 'result', receipt: { protocolVersion: 2, requestId: job.input.requestId, planDigest: job.input.planDigest, challenge: job.input.challenge, outcome: 'unknown' } });
  } catch (error) { journal.close(); throw error; }
  let busy = false;
  async function deliver(receipt) {
    const result = await client.call('report', receipt); journal.append({ kind: 'ack', requestId: receipt.requestId, status: result.status }); return result.status;
  }
  return {
    snapshot: () => journal.read(), close() { if (busy) throw new Error('node channel bridge is busy'); journal.close(); },
    async step() {
      if (busy) throw new Error('node channel bridge is busy'); busy = true;
      try {
        const state = project(journal.read(), context), jobs = [...state.jobs.values()], pending = jobs.find(job => !job.ack);
        if (state.blocked) return 'unknown';
        if (pending) return await deliver(pending.receipt);
        if (jobs.some(job => job.receipt.outcome === 'unknown' || job.ack.status === 'unknown')) return 'unknown';
        const response = await client.call('poll', { protocolVersion: 2 });
        if (response.status !== 'delivery') {
          if (response.status === 'unknown') journal.append({ kind: 'remote-unknown', requestId: response.requestId });
          return response.status;
        }
        const input = verifiedPlan(response.input, context); requireCredential(!jobs.some(job => job.input.requestId === input.requestId));
        journal.append({ kind: 'started', input });
        // 仅确认已校验的控制 probe；没有 executor、shell、Docker 或业务部署调用。
        const receipt = probeReceipt({ protocolVersion: 2, requestId: input.requestId, planDigest: input.planDigest, challenge: input.challenge, outcome: 'observed' });
        journal.append({ kind: 'result', receipt });
        return await deliver(receipt);
      } finally { busy = false; }
    },
  };
}
