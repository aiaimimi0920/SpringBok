import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal } from '../execution/journal.mjs';
import { exact } from '../../cloud/protocol.mjs';
import { nodeContext } from '../../cloud/node-protocol.mjs';
import { isUuid } from '../../cloud/catalog-contract.mjs';
import { isDigest, requireEnrollment } from '../../cloud/enrollment-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function enrollmentGrant(value, expectedOrigin) {
  exact(value, ['protocolVersion', 'origin', 'ownerId', 'nodeId', 'enrollmentId', 'challenge']);
  const context = nodeContext({ ownerId: value.ownerId, nodeId: value.nodeId }), url = new URL(expectedOrigin);
  requireEnrollment(typeof expectedOrigin === 'string' && url.protocol === 'https:' && url.origin === expectedOrigin && !url.username && !url.password && value.origin === expectedOrigin && value.protocolVersion === 2 && isUuid(value.enrollmentId) && isDigest(value.challenge));
  return { protocolVersion: 2, origin: value.origin, ...context, enrollmentId: value.enrollmentId, challenge: value.challenge };
}
function privateDirectory(directory) {
  if (process.platform !== 'linux') throw new Error('node enrollment currently supports Linux only');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  requireEnrollment(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid());
  try { const file = lstatSync(join(directory, 'ledger.json')); requireEnrollment(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.uid === process.getuid()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function acknowledgement(value, grant, prepared) {
  exact(value, ['protocolVersion', 'ownerId', 'nodeId', 'executionReady', 'status', 'enrollmentId', 'expiresAt', 'requestId', 'joinedAt', 'directoryState', 'reconciliationRequired']);
  requireEnrollment(value.protocolVersion === 2 && value.ownerId === grant.ownerId && value.nodeId === grant.nodeId && value.enrollmentId === grant.enrollmentId && value.requestId === prepared.requestId && value.executionReady === false && value.status === 'joined');
  requireEnrollment(Number.isSafeInteger(value.joinedAt) && value.joinedAt >= 0 && Number.isSafeInteger(value.expiresAt) && value.joinedAt < value.expiresAt && ['active', 'uncertain'].includes(value.directoryState) && value.reconciliationRequired === (value.directoryState === 'uncertain'));
  return structuredClone(value);
}
function project(events, grant) {
  let prepared = null, receipt = null;
  for (const [index, event] of events.entries()) {
    requireEnrollment(event.revision === index + 1);
    if (event.kind === 'prepared') {
      exact(event, ['revision', 'kind', 'requestId', 'executeToken', 'observeToken']);
      requireEnrollment(!prepared && isUuid(event.requestId) && isDigest(event.executeToken) && isDigest(event.observeToken) && event.executeToken !== event.observeToken);
      prepared = event;
    } else {
      exact(event, ['revision', 'kind', 'receipt']); requireEnrollment(event.kind === 'receipt' && prepared && receipt?.directoryState !== 'active');
      const next = acknowledgement(event.receipt, grant, prepared);
      if (receipt) requireEnrollment(['protocolVersion', 'ownerId', 'nodeId', 'status', 'enrollmentId', 'expiresAt', 'requestId', 'joinedAt'].every(key => next[key] === receipt[key]) && next.directoryState === 'active');
      receipt = next;
    }
  }
  return { prepared, receipt };
}
export function openEnrollmentClient({ directory, grant: value, expectedOrigin, fetcher = fetch }) {
  // 固定地址必须独立于 grant 确认；比对发生在创建日志、生成秘密或联网之前。
  const grant = enrollmentGrant(value, expectedOrigin); privateDirectory(directory);
  const journal = openJournal(directory, hash(JSON.stringify(['node-enrollment/v2', grant])), events => project(events, grant));
  let busy = false;
  const summary = () => {
    const { prepared, receipt } = project(journal.read(), grant);
    return { status: receipt?.status ?? 'prepared', directoryState: receipt?.directoryState ?? 'unconfirmed', reconciliationRequired: receipt?.reconciliationRequired ?? true, nodeId: grant.nodeId, enrollmentId: grant.enrollmentId,
      ...(prepared ? { requestId: prepared.requestId, executeDigest: hash(prepared.executeToken), observeDigest: hash(prepared.observeToken) } : {}) };
  };
  return {
    snapshot: summary,
    close() { if (busy) throw new Error('enrollment client is busy'); journal.close(); },
    async step() {
      if (busy) throw new Error('enrollment client is busy'); busy = true;
      try {
        let state = project(journal.read(), grant);
        if (state.receipt?.directoryState === 'active') return summary();
        if (!state.prepared) {
          journal.append({ kind: 'prepared', requestId: randomUUID(), executeToken: randomBytes(32).toString('hex'), observeToken: randomBytes(32).toString('hex') });
          state = project(journal.read(), grant);
        }
        const input = { protocolVersion: 2, enrollmentId: grant.enrollmentId, requestId: state.prepared.requestId, executeDigest: hash(state.prepared.executeToken), observeDigest: hash(state.prepared.observeToken) };
        const response = await fetcher(`${expectedOrigin}/node/v2/join/${grant.ownerId}/${grant.nodeId}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${grant.challenge}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
        if (![200, 202].includes(response.status)) { await response.body?.cancel(); throw new Error('join denied or uncertain; preserve original grant and credentials'); }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) { const { done, value: bytes } = await reader.read(); if (done) break; size += bytes.length; if (size > 4096) throw new Error('large join response'); chunks.push(bytes); }
          const data = acknowledgement(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), grant, state.prepared);
          if (!state.receipt || data.directoryState === 'active') journal.append({ kind: 'receipt', receipt: data });
        } finally { await reader.cancel().catch(() => {}); }
        return summary();
      } finally { busy = false; }
    },
  };
}
