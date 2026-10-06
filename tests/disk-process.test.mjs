import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDiskSampler, DISK_DEADLINE_MS, MAX_DISK_OUTPUT_BYTES } from '../src/node-telemetry/disk-process.mjs';
import { unavailableDisk, isDiskSample } from '../src/node-telemetry/disk.mjs';
import { runSamplingLoop } from '../src/node-telemetry/loop.mjs';

function fake() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = []; child.unrefs = 0;
  child.kill = signal => { child.kills.push(signal); return true; }; child.unref = () => { child.unrefs++; }; return child;
}
function fixture(signal) {
  const children = [], timers = [], cleared = [];
  const sampler = createDiskSampler({ signal, spawnWorker: () => { const child = fake(); children.push(child); return child; },
    setTimer: (callback, ms) => { assert.equal(ms, DISK_DEADLINE_MS); const timer = { callback }; timers.push(timer); return timer; }, clearTimer: timer => cleared.push(timer) });
  return { sampler, children, timers, cleared };
}
const output = unavailableDisk('read-failed');

// 采样器刻意 unref 超时/停止的子进程；测试用自己的有界 timer 等待实际 close。
function boundedClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned child did not close before test deadline')), timeoutMs);
    once(child, 'close').then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test('disk worker accepts only one bounded strict JSON result after successful close, and never overlaps', async () => {
  const f = fixture(), pending = f.sampler.sample(), child = f.children[0];
  assert.equal((await f.sampler.sample()).reason, 'worker-busy'); assert.equal(f.children.length, 1);
  child.stdout.write(JSON.stringify(output) + '\n'); assert.equal((await f.sampler.sample()).reason, 'worker-busy');
  child.emit('close', 0, null); assert.deepEqual(await pending, output); assert.equal(f.cleared.length, 1); assert.deepEqual(child.kills, []);
  const second = f.sampler.sample(); f.children[1].emit('close', 2, null); assert.equal((await second).reason, 'worker-failed'); assert.equal(f.children.length, 2);
});

test('disk timeout retains in-flight gate until close; hung workers cannot accumulate and late output is discarded', async () => {
  const f = fixture(), pending = f.sampler.sample(), child = f.children[0];
  f.timers[0].callback(); assert.equal((await pending).reason, 'worker-timeout'); assert.deepEqual(child.kills, ['SIGKILL']); assert.equal(child.unrefs, 1);
  for (let i = 0; i < 20; i++) assert.equal((await f.sampler.sample()).reason, 'worker-busy');
  assert.equal(f.children.length, 1); child.emit('error', new Error('late private error')); assert.equal(child.kills.length, 1);
  child.emit('close', null, 'SIGKILL'); const next = f.sampler.sample(); f.children[1].emit('close', 2, null); await next; assert.equal(f.children.length, 2);
});

test('disk worker rejects stderr, overlarge/invalid UTF-8/multiline JSON, malformed shapes and spawn failures', async () => {
  for (const mode of ['stderr', 'oversize', 'bad-utf8', 'multiline', 'extra-field', 'no-newline', 'empty', 'signal', 'error', 'pipe-error']) {
    const f = fixture(), pending = f.sampler.sample(), child = f.children[0];
    if (mode === 'stderr') child.stderr.write('private-secret');
    if (mode === 'oversize') child.stdout.write(Buffer.alloc(MAX_DISK_OUTPUT_BYTES + 1, 65));
    if (mode === 'bad-utf8') child.stdout.write(Buffer.from([0xff, 10]));
    if (mode === 'multiline') child.stdout.write(JSON.stringify(output) + '\n' + JSON.stringify(output) + '\n');
    if (mode === 'extra-field') child.stdout.write(JSON.stringify({ ...output, secret: 'private' }) + '\n');
    if (mode === 'no-newline') child.stdout.write(JSON.stringify(output));
    if (mode === 'error') child.emit('error', new Error('private'));
    if (mode === 'pipe-error') child.stdout.emit('error', new Error('private'));
    child.emit('close', 0, mode === 'signal' ? 'SIGTERM' : null);
    const sample = await pending; assert.equal(sample.reason, 'worker-failed'); assert.equal(isDiskSample(sample), true); assert.ok(!JSON.stringify(sample).includes('private'));
  }
  const sampler = createDiskSampler({ spawnWorker: () => { throw new Error('private'); } });
  assert.equal((await sampler.sample()).reason, 'worker-failed'); assert.equal((await sampler.sample()).reason, 'worker-failed');
});

test('disk stop aborts own worker and loop, no late output or replacement worker; stopped before sample does not spawn', async () => {
  const stop = new AbortController(), f = fixture(stop.signal), samples = [];
  const running = runSamplingLoop({ sampler: f.sampler, signal: stop.signal, onSample: sample => samples.push(sample), wait: async () => assert.fail('no wait after stopped sample') });
  stop.abort(); await running; assert.deepEqual(samples, []); assert.deepEqual(f.children[0].kills, ['SIGKILL']);
  f.children[0].emit('close', 0, null); assert.equal((await f.sampler.sample()).reason, 'stopped'); assert.equal(f.children.length, 1);
  const before = new AbortController(); before.abort(); assert.equal((await fixture(before.signal).sampler.sample()).reason, 'stopped');
});

test('disk deadline terminates one real hung child and unlocks only after actual close', { timeout: 10000 }, async () => {
  let child, starts = 0;
  const sampler = createDiskSampler({ spawnWorker: () => { starts++; child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }); return child; } });
  const pending = sampler.sample(), closed = boundedClose(child, 8000);
  assert.equal((await sampler.sample()).reason, 'worker-busy'); assert.equal(starts, 1);
  try {
    const result = await pending; assert.equal(result.reason, 'worker-timeout');
    const [code, signal] = await closed; assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.equal(starts, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
});

test('disk stop interrupts one real owned child with no late loop output and no replacement', { timeout: 5000 }, async () => {
  const stop = new AbortController(), samples = []; let child, starts = 0;
  const sampler = createDiskSampler({ signal: stop.signal, spawnWorker: () => {
    starts++; child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }); return child;
  } });
  const running = runSamplingLoop({ sampler, signal: stop.signal, onSample: value => samples.push(value) }), closed = boundedClose(child, 4000);
  try {
    await once(child, 'spawn'); stop.abort(); await running; await closed;
    assert.deepEqual(samples, []); assert.equal(starts, 1); assert.equal((await sampler.sample()).reason, 'stopped'); assert.equal(starts, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
});

test('disk CLI rejects arbitrary paths/options and non-Linux/root with fixed redacted error', () => {
  const cli = fileURLToPath(new URL('../scripts/node-disk.mjs', import.meta.url));
  for (const args of [['--path', '/etc/passwd'], ['--interval', '1'], ['--credential', 'private.json']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Disk collection stopped/); assert.ok(!result.stderr.includes('private.json'));
  }
  if (process.platform !== 'linux' || process.getuid() === 0) assert.equal(spawnSync(process.execPath, [cli], { timeout: 5000 }).status, 2);
});

test('normal Linux disk CLI emits a valid namespace gauge and stops on both signals during its 30s wait', { timeout: 20000,
  skip: process.platform !== 'linux' || process.getuid() === 0 ? 'requires normal Linux user' : false }, async () => {
  const cli = fileURLToPath(new URL('../scripts/node-disk.mjs', import.meta.url));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const child = spawn(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'] }), exited = once(child, 'close'); let stdout = '', stderr = '';
    const first = new Promise((resolve, reject) => {
      child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) resolve(); });
      child.once('error', reject); child.once('close', () => { if (!stdout.includes('\n')) reject(new Error('No disk sample')); });
    });
    child.stderr.on('data', data => { stderr += data; }); const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      await first; assert.equal(isDiskSample(JSON.parse(stdout.trim())), true); child.kill(signal);
      const [code] = await exited; assert.equal(code, 0); assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  }
});
