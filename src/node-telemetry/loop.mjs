import { setTimeout as delay } from 'node:timers/promises';
import { CPU_INTERVAL_MS } from './cpu.mjs';

// 独立只读采集，不复用执行任务的网络退避或持久 journal。
export async function runCpuLoop({ sampler, signal, onSample, wait = (ms, abort) => delay(ms, undefined, { signal: abort }) }) {
  while (!signal.aborted) {
    const sample = await sampler.sample();
    if (signal.aborted) break;
    onSample(sample);
    try { await wait(CPU_INTERVAL_MS, signal); }
    catch (error) { if (!signal.aborted || error.name !== 'AbortError') throw error; }
  }
}
