import { fixtureEvidence } from './fixture-contract.mjs';
export const NODE = 'pc2-test';
const hex = /^[a-f0-9]{64}$/;
export function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid protocol');
  const found = Object.keys(value).sort(), expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, i) => key !== expected[i])) throw new Error('invalid protocol');
}
export function submission(value) {
  exact(value, ['id', 'node', 'operation', 'challenge', 'revision']);
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) || value.node !== NODE || !['protocol-probe', 'fixture-cycle'].includes(value.operation) || typeof value.challenge !== 'string' || !hex.test(value.challenge) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('invalid protocol');
  return { id: value.id, node: value.node, operation: value.operation, challenge: value.challenge, revision: value.revision };
}
export function report(value) {
  exact(value, value.outcome === 'fixture-verified' ? ['id', 'challenge', 'outcome', 'evidence'] : ['id', 'challenge', 'outcome']);
  submission({ id: value.id, node: NODE, operation: 'protocol-probe', challenge: value.challenge, revision: 0 });
  if (value.outcome === 'fixture-verified') fixtureEvidence(value.evidence, value.challenge);
  if (!['observed', 'unknown', 'fixture-verified'].includes(value.outcome)) throw new Error('invalid protocol');
  return { id: value.id, challenge: value.challenge, outcome: value.outcome, ...(value.outcome === 'fixture-verified' ? { evidence: fixtureEvidence(value.evidence, value.challenge) } : {}) };
}
export function ledger(value) {
  exact(value, ['revision', 'jobs']);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.jobs) || value.jobs.length > 100) throw new Error('invalid ledger');
  const ids = new Set();
  for (const job of value.jobs) {
    exact(job, job.receipt ? ['input', 'status', 'expiresAt', 'receipt'] : ['input', 'status', 'expiresAt']); submission(job.input);
    if (job.receipt) { report(job.receipt); if (job.receipt.id !== job.input.id || job.receipt.challenge !== job.input.challenge || job.receipt.outcome !== job.status) throw new Error('invalid ledger receipt'); }
    if (ids.has(job.input.id) || !['queued', 'claimed', 'observed', 'fixture-verified', 'unknown', 'expired'].includes(job.status) || !Number.isSafeInteger(job.expiresAt) || job.expiresAt < 0) throw new Error('invalid ledger');
    if ((job.status === 'fixture-verified' && (!job.receipt || job.input.operation !== 'fixture-cycle')) || (job.status === 'observed' && job.input.operation !== 'protocol-probe')) throw new Error('invalid operation result');
    ids.add(job.input.id);
  }
  if (value.jobs.filter(j => ['queued', 'claimed', 'unknown'].includes(j.status)).length > 1) throw new Error('invalid ledger');
  return structuredClone(value);
}
export function transition(current, operation, value, now) {
  const state = ledger(current); let response, changed = false;
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
  if (operation === 'submit') {
    const input = submission(value), old = state.jobs.find(j => j.input.id === input.id);
    if (old) {
      if (JSON.stringify(old.input) !== JSON.stringify(input)) throw new Error('request conflict');
      return { state, response: { status: old.status, id: input.id }, changed: false };
    }
    if (input.revision !== state.revision || state.jobs.length >= 100 || state.jobs.some(j => ['queued', 'claimed', 'unknown'].includes(j.status))) throw new Error('request conflict');
    state.jobs.push({ input, status: 'queued', expiresAt: now + (input.operation === 'fixture-cycle' ? 600000 : 120000) }); changed = true;
    response = { status: 'queued', id: input.id };
  } else if (operation === 'poll') {
    exact(value, ['node']); if (value.node !== NODE) throw new Error('wrong node');
    const job = state.jobs.find(j => ['queued', 'claimed', 'unknown'].includes(j.status));
    if (!job) response = { status: 'idle' };
    else if (job.status === 'queued') {
      if (now >= job.expiresAt) { job.status = 'expired'; response = { status: 'expired', id: job.input.id }; }
      else { job.status = 'claimed'; response = { status: 'delivery', input: structuredClone(job.input) }; }
      changed = true;
    } else {
      if (job.status === 'claimed' && now >= job.expiresAt) { job.status = 'unknown'; changed = true; }
      response = { status: job.status, id: job.input.id }; // Never redeliver a claimed command.
    }
  } else if (operation === 'report') {
    const receipt = report(value), job = state.jobs.find(j => j.input.id === receipt.id);
    if (!job || job.input.challenge !== receipt.challenge || !['claimed', 'unknown', 'observed', 'fixture-verified'].includes(job.status)) throw new Error('receipt conflict');
    if (receipt.outcome !== 'unknown' && receipt.outcome !== (job.input.operation === 'fixture-cycle' ? 'fixture-verified' : 'observed')) throw new Error('receipt operation mismatch');
    if (job.receipt && JSON.stringify(job.receipt) !== JSON.stringify(receipt)) throw new Error('receipt conflict');
    if (job.status === 'claimed' && now >= job.expiresAt) { job.status = 'unknown'; changed = true; }
    if (job.status === 'unknown') { if (changed) state.revision++; return { state: ledger(state), response: { status: 'unknown', id: receipt.id }, changed }; }
    if (job.status === 'observed' && receipt.outcome !== 'observed') throw new Error('receipt conflict');
    if (job.status !== receipt.outcome) { job.status = receipt.outcome; if (receipt.outcome === 'fixture-verified') job.receipt = receipt; changed = true; }
    response = { status: job.status, id: receipt.id };
  } else throw new Error('unknown operation');
  if (changed) state.revision++;
  return { state: ledger(state), response, changed };
}
