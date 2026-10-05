import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDiskSample } from '../../src/node-telemetry/disk.mjs';

// 真实普通用户 CLI 与独立 GNU df/stat 对照，不写数据、不挂载、不清理/填满磁盘。
assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
const children = new Set(), cli = fileURLToPath(new URL('../node-disk.mjs', import.meta.url));
function start(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  const state = { child, stdout: '', stderr: '', done: false, error: null }; children.add(state);
  state.exit = new Promise(resolve => {
    child.on('error', error => { state.error = error; if (!child.pid) { state.done = true; resolve({ code: null }); } });
    child.on('close', (code, signal) => { state.done = true; resolve({ code, signal }); });
  });
  for (const name of ['stdout', 'stderr']) child[name].on('data', data => {
    state[name] += data;
    if (Buffer.byteLength(state[name]) > 393216) { state.error = new Error('Disk test output exceeded bound'); child.kill('SIGKILL'); }
  });
  return state;
}
async function waitFor(state, predicate, timeout = 40000) {
  const deadline = performance.now() + timeout;
  while (!predicate(state.stdout)) {
    if (state.error) throw state.error;
    if (state.done || performance.now() >= deadline) throw new Error('Disk test process stopped or timed out');
    await delay(20);
  }
}
async function stop(state) {
  if (state.done) { children.delete(state); return; }
  state.child.kill('SIGTERM'); const timer = setTimeout(() => state.child.kill('SIGKILL'), 3000);
  try { await state.exit; } finally { clearTimeout(timer); children.delete(state); }
}
async function reference(command, args) {
  const state = start(command, args);
  await waitFor(state, () => state.done, 7000);
  assert.equal((await state.exit).code, 0); assert.equal(state.stderr, ''); children.delete(state); return state.stdout;
}
const samples = text => text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
try {
  const collector = start(process.execPath, [cli]), proof = [];
  for (let i = 0; i < 2; i++) {
    await waitFor(collector, text => samples(text).length > i);
    const sample = samples(collector.stdout)[i]; assert.equal(isDiskSample(sample), true); assert.equal(sample.status, 'available');
    assert.ok(sample.mounts.some(mount => mount.mountPoint === '/'), 'native acceptance must include a supported namespace root');
    const comparisons = [];
    for (const mount of sample.mounts) {
      const raw = await reference('/usr/bin/df', ['--block-size=1', '--output=size,used,avail,pcent', '--', mount.mountPoint]);
      const fields = raw.trim().split('\n'); assert.equal(fields.length, 2);
      const values = fields[1].trim().split(/\s+/); assert.equal(values.length, 4); assert.match(values[3], /^(0|[1-9][0-9]{0,2})%$/);
      const [totalBytes, usedBytes, availableBytes] = values.slice(0, 3).map(Number);
      assert.ok([totalBytes, usedBytes, availableBytes].every(Number.isSafeInteger)); assert.ok(totalBytes > 0 && usedBytes >= 0 && availableBytes >= 0);
      const denominator = BigInt(usedBytes) + BigInt(availableBytes); assert.ok(denominator > 0n);
      const dfPercent = Number((BigInt(usedBytes) * 100n + denominator - 1n) / denominator);
      assert.equal(Number(values[3].slice(0, -1)), dfPercent, 'df reference must use ceil(used/(used+available))');
      const sizes = (await reference('/usr/bin/stat', ['--file-system', '--format=%S %s', '--', mount.mountPoint])).trim().split(' ').map(Number);
      assert.equal(sizes.length, 2); assert.ok(sizes[0] > 0); assert.equal(sizes[0], sizes[1], 'supported native FS fundamental and transfer block sizes must match');
      assert.equal(mount.totalBytes, totalBytes);
      const toleranceBytes = Math.max(16777216, Math.ceil(totalBytes / 10000));
      const usedDifferenceBytes = Math.abs(mount.usedBytes - usedBytes), availableDifferenceBytes = Math.abs(mount.availableBytes - availableBytes);
      assert.ok(usedDifferenceBytes <= toleranceBytes); assert.ok(availableDifferenceBytes <= toleranceBytes);
      assert.equal(mount.reservedBytes, totalBytes - usedBytes - availableBytes);
      const dfRoundedPercent = Number((BigInt(usedBytes) * 10000n + denominator / 2n) / denominator) / 100;
      const percentDifference = Math.abs(mount.usagePercent - dfRoundedPercent);
      const percentTolerance = Math.min(100, 0.01 + 200 * toleranceBytes / Math.min(Number(denominator), mount.usedBytes + mount.availableBytes));
      assert.ok(percentDifference <= percentTolerance, 'collector rounded ratio must agree with the independent df bytes within the time-window bound');
      comparisons.push({ mountPoint: mount.mountPoint, fsType: mount.fsType, fundamentalBlockSize: sizes[0], transferBlockSize: sizes[1],
        df: { totalBytes, usedBytes, availableBytes, ceilPercent: dfPercent, roundedPercent: dfRoundedPercent },
        usedDifferenceBytes, availableDifferenceBytes, toleranceBytes, percentDifference, percentTolerance });
    }
    const result = { phase: i === 0 ? 'immediate-gauge' : 'second-gauge-after-30s', sample, comparisons }; proof.push(result); console.log(JSON.stringify(result));
  }
  assert.ok(Date.parse(proof[1].sample.sampledAt) - Date.parse(proof[0].sample.sampledAt) >= 30000);
  await stop(collector); assert.equal((await collector.exit).code, 0); assert.equal(collector.stderr, ''); assert.equal(samples(collector.stdout).length, 2);
  console.log('PASS disk native: two real CLI namespace gauges >=30s apart, GNU df exact total/reserved, independently bounded rounded-ratio agreement and df ceil formula, used/available within max(16MiB,0.01% total), fundamental/transfer sizes equal, normal user and SIGTERM clean stop; no writes, pressure, mounts, installation or upload');
} finally { for (const state of [...children]) await stop(state); }
