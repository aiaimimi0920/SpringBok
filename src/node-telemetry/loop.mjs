import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
export const COLLECTION_INTERVAL_MS = 30000;

async function exactDelay(ms, abort) {
  const deadline = performance.now() + ms;
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) return;
    await delay(remaining, undefined, { signal: abort });
  }
}

// 独立只读采集，不复用执行任务的网络退避或持久 journal。
export async function runSamplingLoop({ sampler, signal, onSample, wait = exactDelay }) {
  while (!signal.aborted) {
    const sample = await sampler.sample();
    if (signal.aborted) break;
    onSample(sample);
    try { await wait(COLLECTION_INTERVAL_MS, signal); }
    catch (error) { if (!signal.aborted || error.name !== 'AbortError') throw error; }
  }
}

// 保留 M01 的公开入口；同步输出回调和停止语义不变。
export const runCpuLoop = runSamplingLoop;
