import { setTimeout as delay } from 'node:timers/promises';
import { RetryableNodeError } from '../node-credentials/client.mjs';

export const MIN_POLL_MS = 30000;
export const MAX_BACKOFF_MS = 300000;
const STATUSES = new Set(['idle', 'observed', 'authenticated', 'claimed', 'expired', 'unknown']);
export function pollDelay(failures, random = Math.random) {
  if (!Number.isInteger(failures) || failures < 0) throw new Error('invalid daemon failure count');
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('invalid daemon jitter');
  const base = MIN_POLL_MS * 2 ** Math.min(Math.max(failures - 1, 0), 4);
  return Math.min(MAX_BACKOFF_MS, Math.floor(base * (1 + sample * 0.2)));
}
export async function runNodeLoop({ step, signal, onEvent = () => {}, random = Math.random, wait = (ms, abort) => delay(ms, undefined, { signal: abort }) }) {
  let failures = 0, previous;
  function emit(status) {
    if (status !== previous) { onEvent({ event: 'status', status, executionReady: false }); previous = status; }
  }
  while (!signal.aborted) {
    try {
      const status = await step();
      if (!STATUSES.has(status)) throw new Error('invalid daemon status');
      if (status === 'unknown') { emit('unknown'); return 'blocked'; }
      failures = 0; emit(status);
    } catch (error) {
      if (!(error instanceof RetryableNodeError)) throw error;
      if (signal.aborted) break;
      failures = Math.min(failures + 1, 5); emit('retrying');
    }
    if (signal.aborted) break;
    const milliseconds = pollDelay(failures, random);
    try { await wait(milliseconds, signal); }
    catch (error) { if (!signal.aborted || error.name !== 'AbortError') throw error; }
  }
  return 'stopped';
}
