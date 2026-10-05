import { setTimeout as delay } from 'node:timers/promises';
export const COLLECTION_INTERVAL_MS = 30000;

// 独立只读采集，不复用执行任务的网络退避或持久 journal。
export async function runSamplingLoop({ sampler, signal, onSample, wait = (ms, abort) => delay(ms, undefined, { signal: abort }) }) {
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
