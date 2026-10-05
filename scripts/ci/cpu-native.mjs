import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// 一次性 Linux runner 上独立 procps top 对照；不安装工具、不挂宿主路径。
assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
const cli = fileURLToPath(new URL('../node-cpu.mjs', import.meta.url)), children = new Set();
function start(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  const state = { child, stdout: '', stderr: '', done: false, error: null };
  children.add(state);
  state.exit = new Promise(resolve => {
    child.on('error', error => { state.error = error; if (!child.pid) { state.done = true; resolve({ code: null, signal: null }); } });
    child.on('close', (code, signal) => { state.done = true; resolve({ code, signal }); });
  });
  for (const name of ['stdout', 'stderr']) child[name].on('data', data => {
    state[name] += data;
    if (state[name].length > 1048576) { state.error = new Error('CPU test output exceeded bound'); child.kill('SIGTERM'); }
  });
  return state;
}
async function waitFor(state, predicate, timeout = 35000) {
  const deadline = performance.now() + timeout;
  while (!predicate(state.stdout)) {
    if (state.error) throw state.error;
    if (state.done || performance.now() > deadline) throw new Error('CPU test process stopped or timed out');
    await delay(20);
  }
}
async function stop(state) {
  if (state.done) { children.delete(state); return; }
  state.child.kill('SIGTERM');
  const timer = setTimeout(() => state.child.kill('SIGKILL'), 3000);
  try { await state.exit; } finally { clearTimeout(timer); children.delete(state); }
}
function lines(text) { return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean); }
function samples(text) { return lines(text).map(line => JSON.parse(line)); }
function summaries(text) { return lines(text).filter(line => /^%Cpu\(s\):/.test(line)); }

try {
  const readings = [];
  for (const phase of ['idle-window', 'one-worker-load']) {
    const worker = phase === 'one-worker-load' ? start(process.execPath, ['-e', 'console.log("load-ready"); setInterval(() => { const c = process.cpuUsage(); console.log(JSON.stringify({ cpuMicroseconds: c.user + c.system })); }, 1000).unref(); let x = 1; function burn() { for (let i = 0; i < 1000000; i++) x = Math.sqrt(x + 1); setImmediate(burn); } burn();']) : null;
    if (worker) await waitFor(worker, text => text.includes('load-ready\n'), 5000);
    const sampler = start(process.execPath, [cli]);
    await waitFor(sampler, text => text.includes('\n'), 5000);
    assert.equal(samples(sampler.stdout)[0].reason, 'warming-up');
    const top = start('/usr/bin/top', ['-b', '-n', '2', '-d', '30', '-w', '512']);
    await waitFor(top, text => summaries(text).length === 2);
    await waitFor(sampler, text => samples(text).length === 2);
    const sample = samples(sampler.stdout)[1], summary = summaries(top.stdout)[1];
    assert.equal(sample.status, 'available'); assert.equal(sample.scope, 'linux-proc-stat'); assert.ok(sample.intervalMs >= 30000);
    const fields = Object.fromEntries([...summary.matchAll(/([0-9]+(?:\.[0-9]+)?)\s+(us|sy|ni|id|wa|hi|si|st)/g)].map(m => [m[2], Number(m[1])]));
    assert.equal(Object.keys(fields).length, 8);
    if (!worker) assert.ok(fields.id >= 70, 'Idle reference window must have at least 70% idle CPU');
    const referencePercent = 100 - fields.id - fields.wa, difference = Math.abs(referencePercent - sample.usagePercent);
    // 两个独立进程窗口仅有启动/读取毫秒级差异；top 自身四舍五入到 0.1%。
    assert.ok(difference <= 1, `CPU disagreement: sample=${sample.usagePercent} top=${referencePercent}`);
    const loadCpuMicroseconds = worker ? JSON.parse(lines(worker.stdout).at(-1)).cpuMicroseconds : 0;
    if (worker) {
      assert.ok(loadCpuMicroseconds >= 1000000, 'Load worker must actually consume at least one CPU second');
      assert.ok(sample.usagePercent - readings[0].sample.usagePercent >= 10 / sample.logicalCpuCount, 'Controlled load must increase aggregate CPU usage');
    }
    const result = { phase, sample, topSummary: summary.trim(), referencePercent: Math.round(referencePercent * 100) / 100, difference: Math.round(difference * 100) / 100, loadCpuMicroseconds };
    readings.push(result); console.log(JSON.stringify(result));
    await stop(sampler); assert.equal((await sampler.exit).code, 0); assert.equal(sampler.stderr, ''); assert.equal(samples(sampler.stdout).length, 2);
    assert.equal((await top.exit).code, 0); assert.equal(top.stderr, ''); children.delete(top);
    if (worker) { assert.equal(worker.done, false); assert.equal(worker.stderr, ''); await stop(worker); }
  }
  assert.equal(readings[0].sample.logicalCpuCount, readings[1].sample.logicalCpuCount);
  console.log('PASS CPU native: two real >=30s CLI windows, procps top idle/load agreement <=1 percentage point, idle >=70%, bounded worker consumed CPU and raised usage, normal user, SIGTERM clean stop; no host installation or metrics upload');
} finally { for (const child of [...children]) await stop(child); }
