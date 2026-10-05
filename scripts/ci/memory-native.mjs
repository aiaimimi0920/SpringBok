import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// 一次性普通 Linux 用户的真实 CLI 与独立 procps free 对照；不施加内存压力。
assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
const children = new Set(), cli = fileURLToPath(new URL('../node-memory.mjs', import.meta.url));
function start(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  const state = { child, stdout: '', stderr: '', done: false, error: null }; children.add(state);
  state.exit = new Promise(resolve => {
    child.on('error', error => { state.error = error; if (!child.pid) { state.done = true; resolve({ code: null }); } });
    child.on('close', (code, signal) => { state.done = true; resolve({ code, signal }); });
  });
  for (const name of ['stdout', 'stderr']) child[name].on('data', data => {
    state[name] += data;
    if (state[name].length > 65536) { state.error = new Error('Memory test output exceeded bound'); child.kill('SIGTERM'); }
  });
  return state;
}
async function waitFor(state, predicate, timeout = 35000) {
  const deadline = performance.now() + timeout;
  while (!predicate(state.stdout)) {
    if (state.error) throw state.error;
    if (state.done || performance.now() >= deadline) throw new Error('Memory test process stopped or timed out');
    await delay(20);
  }
}
async function stop(state) {
  if (state.done) { children.delete(state); return; }
  state.child.kill('SIGTERM'); const timer = setTimeout(() => state.child.kill('SIGKILL'), 3000);
  try { await state.exit; } finally { clearTimeout(timer); children.delete(state); }
}
const lines = text => text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
const samples = text => lines(text).map(line => JSON.parse(line));
function references(text) {
  return lines(text).filter(line => /^Mem:/.test(line)).map(line => {
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    assert.equal(values.length, 7); assert.ok(values.every(Number.isSafeInteger));
    const [totalBytes, usedBytes, freeBytes, sharedBytes, buffersBytes, cacheBytes, availableBytes] = values;
    assert.ok(totalBytes > 0 && availableBytes >= 0 && availableBytes <= totalBytes);
    assert.equal(usedBytes, totalBytes - availableBytes, 'procps free must use the reviewed total-minus-available semantics');
    return { totalBytes, availableBytes, usedBytes, freeBytes, sharedBytes, buffersBytes, cacheBytes };
  });
}
try {
  const reference = start('/usr/bin/free', ['-b', '-w', '-s', '30', '-c', '2']);
  const collector = start(process.execPath, [cli]), readings = [];
  await waitFor(collector, text => samples(text).length === 2);
  await waitFor(reference, text => references(text).length === 2);
  const actual = samples(collector.stdout), expected = references(reference.stdout);
  assert.equal(actual.length, 2); assert.equal(expected.length, 2);
  assert.ok(Date.parse(actual[1].sampledAt) - Date.parse(actual[0].sampledAt) >= 30000);
  for (let i = 0; i < 2; i++) {
    const sample = actual[i], free = expected[i];
    assert.equal(sample.status, 'available'); assert.equal(sample.reason, null); assert.equal(sample.scope, 'linux-proc-meminfo'); assert.equal(sample.unit, 'bytes');
    assert.equal(sample.totalBytes, free.totalBytes); assert.equal(sample.usedBytes, sample.totalBytes - sample.availableBytes);
    assert.equal(sample.usagePercent, Math.round(sample.usedBytes / sample.totalBytes * 10000) / 100);
    const toleranceBytes = Math.max(16777216, Math.ceil(free.totalBytes / 400)), differenceBytes = Math.abs(sample.availableBytes - free.availableBytes);
    assert.ok(differenceBytes <= toleranceBytes, `Memory disagreement: available difference=${differenceBytes} tolerance=${toleranceBytes}`);
    assert.ok(Math.abs(sample.usedBytes - free.usedBytes) <= toleranceBytes);
    const result = { phase: i === 0 ? 'immediate-gauge' : 'second-gauge-after-30s', sample, free, differenceBytes, toleranceBytes };
    readings.push(result); console.log(JSON.stringify(result));
  }
  await stop(collector); assert.equal((await collector.exit).code, 0); assert.equal(collector.stderr, ''); assert.equal(samples(collector.stdout).length, 2);
  await waitFor(reference, () => reference.done, 3000);
  assert.equal((await reference.exit).code, 0); assert.equal(reference.stderr, ''); children.delete(reference);
  console.log('PASS memory native: two real CLI gauges >=30s apart, procps free exact total/used formula and available agreement within max(16MiB,0.25% total), normal user and SIGTERM clean stop; no memory pressure, installation or upload');
} finally { for (const child of [...children]) await stop(child); }
