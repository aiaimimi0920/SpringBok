import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// 一次性普通用户回环流量；独立 sysfs 计数为 CLI 两次采样建立上下界。
assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
const cli = fileURLToPath(new URL('../node-network.mjs', import.meta.url));
const payloadBytes = 4 * 1024 * 1024;
async function reference() {
  const result = {};
  for (const direction of ['rx', 'tx']) {
    const text = await readFile(`/sys/class/net/lo/statistics/${direction}_bytes`, 'utf8');
    assert.match(text, /^[0-9]+\n$/); result[direction] = BigInt(text.trim());
  }
  return result;
}
async function traffic() {
  const sockets = new Set(); let received = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('data', data => { received += data.length; });
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  });
  let client, timer;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    client = createConnection({ host: '127.0.0.1', port: server.address().port });
    timer = setTimeout(() => { client.destroy(new Error('Loopback transfer timeout')); for (const socket of sockets) socket.destroy(); }, 5000);
    const closed = once(client, 'close'); client.end(Buffer.alloc(payloadBytes, 0x53)); await closed;
    assert.equal(received, payloadBytes);
  } finally {
    clearTimeout(timer); client?.destroy(); for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  return received;
}

const firstReference = await reference();
const child = spawn(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', done = false, error;
const exit = new Promise(resolve => {
  child.on('error', value => { error = value; if (!child.pid) { done = true; resolve({ code: null }); } });
  child.on('close', (code, signal) => { done = true; resolve({ code, signal }); });
});
for (const [name, append] of [['stdout', data => { stdout += data; }], ['stderr', data => { stderr += data; }]]) child[name].on('data', data => {
  append(data); if (stdout.length + stderr.length > 262144) { error = new Error('Network test output exceeded bound'); child.kill('SIGTERM'); }
});
const samples = () => stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
async function waitFor(count) {
  const deadline = performance.now() + 35000;
  while (samples().length < count) {
    if (error) throw error;
    if (done || performance.now() >= deadline) throw new Error('Network collector stopped or timed out');
    await delay(10);
  }
}
try {
  await waitFor(1); const warm = samples()[0]; assert.equal(warm.reason, 'warming-up');
  const afterWarm = await reference(); await traffic(); const beforeRate = await reference();
  await waitFor(2); const afterRate = await reference(), sample = samples()[1];
  assert.equal(sample.status, 'available'); assert.equal(sample.scope, 'linux-network-namespace'); assert.equal(sample.unit, 'bytes-per-second');
  assert.ok(sample.intervalMs >= 30000); assert.ok(Date.parse(sample.sampledAt) - Date.parse(warm.sampledAt) >= 30000);
  const lo = sample.interfaces.find(row => row.name === 'lo'); assert.equal(lo.status, 'available');
  const comparisons = {};
  for (const direction of ['rx', 'tx']) {
    const lower = beforeRate[direction] - afterWarm[direction], upper = afterRate[direction] - firstReference[direction];
    const delta = BigInt(lo[`${direction}Bytes`]), rate = lo[`${direction}BytesPerSecond`];
    assert.ok(lower >= BigInt(payloadBytes)); assert.ok(delta >= lower && delta <= upper, `${direction} differs from independent counter brackets`);
    assert.ok(Math.abs(rate - Number(delta) * 1000 / sample.intervalMs) <= 0.005001);
    comparisons[direction] = { lowerBytes: lower.toString(), upperBytes: upper.toString(), measuredBytes: delta.toString(), bytesPerSecond: rate };
  }
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { assert.equal((await exit).code, 0); } finally { clearTimeout(timer); }
  assert.equal(stderr, ''); assert.equal(samples().length, 2);
  console.log(JSON.stringify({ sample, payloadBytes, receivedPayloadBytes: payloadBytes, independentSysfsBrackets: comparisons, gracefulStop: true }));
  console.log('PASS network native: real normal-user CLI warm-up and >=30s rate, 4MiB loopback-only transfer, independent sysfs RX/TX byte brackets and rate formula, SIGTERM without late output; no external requests, capture, installation or upload');
} finally {
  if (!done) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); try { await exit; } finally { clearTimeout(timer); } }
}
