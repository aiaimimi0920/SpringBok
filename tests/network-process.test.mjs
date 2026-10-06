import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/node-network.mjs', import.meta.url));
test('network CLI rejects arbitrary paths, credentials, intervals, root and non-Linux', () => {
  const args = [['--path', '/etc/passwd'], ['--interval', '1'], ['--credential', 'private.json']];
  if (process.platform !== 'linux' || process.getuid() === 0) args.push([]);
  for (const options of args) {
    const result = spawnSync(process.execPath, [cli, ...options], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Network collection stopped/); assert.ok(!result.stderr.includes('private.json'));
  }
});

test('normal Linux network CLI emits one warm-up and both signals stop without late samples', { timeout: 10000, skip: process.platform !== 'linux' || process.getuid() === 0 ? 'requires normal Linux user' : false }, async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const child = spawn(process.execPath, [cli], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'close'); let stdout = '', stderr = '';
    const firstLine = new Promise((resolve, reject) => {
      child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) resolve(); });
      child.once('error', reject); child.once('close', () => { if (!stdout.includes('\n')) reject(new Error('No complete network sample')); });
    });
    child.stderr.on('data', data => { stderr += data; }); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await firstLine; const sample = JSON.parse(stdout.trim()); assert.equal(sample.reason, 'warming-up'); assert.ok(sample.interfaces.length > 0);
      child.kill(signal); const [code] = await exited; assert.equal(code, 0); assert.equal(stderr, ''); assert.equal(stdout.trim().split('\n').length, 1);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  }
});
