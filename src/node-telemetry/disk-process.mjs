import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDiskSample, unavailableDisk } from './disk.mjs';

export const DISK_DEADLINE_MS = 5000, MAX_DISK_OUTPUT_BYTES = 196608;
const worker = fileURLToPath(new URL('./disk-worker.mjs', import.meta.url));

// 超时只停止等待并杀自有 worker，不声称取消 statfs；未 close 时不启动替代进程。
export function createDiskSampler({ signal, spawnWorker = () => spawn(process.execPath, [worker], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { LANG: 'C', LC_ALL: 'C' }, windowsHide: true,
}), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = null, stopped = false;
  return Object.freeze({ sample() {
    if (stopped || signal?.aborted) return Promise.resolve(unavailableDisk('stopped'));
    if (active) return Promise.resolve(unavailableDisk('worker-busy'));
    return new Promise(resolve => {
      let child;
      try { child = spawnWorker(); } catch { resolve(unavailableDisk('worker-failed')); return; }
      active = child;
      let finished = false, bytes = 0, chunks = [], stderrBytes = 0, timer;
      const finish = sample => {
        if (finished) return;
        finished = true; clearTimer(timer); signal?.removeEventListener('abort', abort); resolve(sample);
      };
      const terminate = reason => {
        if (finished) return;
        chunks = []; finish(unavailableDisk(reason));
        // 只使用保存的 ChildProcess，不扫描 PID、不批量清理。D-state 可能延迟实际退出。
        child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      };
      const abort = () => { stopped = true; terminate('stopped'); };
      child.on('error', () => terminate('worker-failed'));
      child.stdout.on('error', () => terminate('worker-failed'));
      child.stderr.on('error', () => terminate('worker-failed'));
      child.stdout.on('data', data => {
        if (finished) return;
        bytes += data.length;
        if (bytes > MAX_DISK_OUTPUT_BYTES) { terminate('worker-failed'); return; }
        chunks.push(data);
      });
      child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes) terminate('worker-failed'); });
      child.once('close', (code, exitSignal) => {
        if (active === child) active = null;
        if (finished) return;
        try {
          if (code !== 0 || exitSignal || stderrBytes) throw new Error('Worker failed');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error('Invalid worker output');
          const sample = JSON.parse(text);
          if (!isDiskSample(sample)) throw new Error('Invalid worker sample');
          finish(sample);
        } catch { finish(unavailableDisk('worker-failed')); }
        chunks = [];
      });
      timer = setTimer(() => terminate('worker-timeout'), DISK_DEADLINE_MS);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } });
}
