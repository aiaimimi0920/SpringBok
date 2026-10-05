import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/node-memory.mjs', import.meta.url));
test('memory CLI rejects arbitrary paths/options and unsupported platform/root with fixed redacted error', () => {
  for (const args of [['--path', '/etc/passwd'], ['--interval', '1'], ['--credential', 'private.json']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Memory collection stopped/); assert.ok(!result.stderr.includes('private.json')); assert.ok(!result.stderr.includes('/etc/passwd'));
  }
  if (process.platform !== 'linux' || process.getuid() === 0) {
    const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 5000 }); assert.equal(result.status, 2); assert.equal(result.stdout, '');
  }
});

test('normal Linux memory CLI emits an immediate gauge and stops on either signal during the 30s wait', { timeout: 10000, skip: process.platform !== 'linux' || process.getuid() === 0 ? 'requires normal Linux user' : false }, async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const child = spawn(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'close'); let stdout = '', stderr = '';
    const firstLine = new Promise((resolve, reject) => {
      child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) resolve(); });
      child.once('error', reject); child.once('close', () => { if (!stdout.includes('\n')) reject(new Error('No complete memory sample')); });
    });
    child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await firstLine; const sample = JSON.parse(stdout.trim());
      assert.equal(sample.status, 'available'); assert.ok(sample.totalBytes > 0); assert.equal(sample.usedBytes, sample.totalBytes - sample.availableBytes); child.kill(signal);
      const [code] = await exited; assert.equal(code, 0); assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1);
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  }
});
