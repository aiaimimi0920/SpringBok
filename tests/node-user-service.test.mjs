import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installNode } from '../src/node-install/install.mjs';
import { userUnit, installUserUnit } from '../src/node-service/user-unit.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';

function setup(role = 'execute', name = 'installed') {
  assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0);
  const f = packageFixture(), r = roleFixture(f.directory, role), installation = join(f.directory, name), unitDirectory = join(f.directory, 'units');
  installNode({ packageDirectory: f.packageDirectory, expectedSha256: f.built.sha256, credentialFile: r.credentialFile, expectedOrigin: r.credential.origin, role, directory: installation });
  fs.mkdirSync(unitDirectory, { mode: 0o700 });
  return { ...f, ...r, installation, unitDirectory };
}
function snapshot(directory) {
  const result = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result[entry.name] = snapshot(path);
    else {
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { const stat = fs.fstatSync(fd); result[entry.name] = { ino: stat.ino, dev: stat.dev, mode: stat.mode, mtimeMs: stat.mtimeMs, data: fs.readFileSync(fd) }; }
      finally { fs.closeSync(fd); }
    }
  }
  return result;
}
test('fixed user units preserve both role installations and publish idempotently without secrets or restart', () => {
  for (const role of ['execute', 'observe']) {
    const f = setup(role);
    try {
      fs.writeFileSync(join(f.installation, 'state/ledger.json'), 'preserve unknown', { mode: 0o600 });
      fs.writeFileSync(join(f.installation, 'state/daemon.lock'), 'preserve lock', { mode: 0o600 });
      const before = snapshot(f.installation), first = installUserUnit(f);
      assert.equal(first.status, 'installed'); assert.equal(first.name, `springbok-control-${role}.service`);
      assert.match(first.contents, /\nRestart=no\n/); assert.match(first.contents, /\nWantedBy=default.target\n/);
      assert.match(first.contents, /\nKillSignal=SIGTERM\nKillMode=control-group\nTimeoutStopSec=30s\n/);
      assert.equal(first.contents.includes(f.credential.token), false); assert.equal(first.executionReady, false);
      const unitBefore = snapshot(f.unitDirectory);
      assert.equal(installUserUnit(f).status, 'verified'); assert.deepEqual(snapshot(f.unitDirectory), unitBefore);
      assert.deepEqual(snapshot(f.installation), before); assert.equal(fs.statSync(first.path).mode & 0o077, 0);
      const parser = spawnSync('systemd-analyze', ['--user', 'verify', '--man=no', first.path], { encoding: 'utf8', timeout: 10000, env: { ...process.env, XDG_RUNTIME_DIR: f.directory } });
      assert.equal(parser.status, 0, parser.stderr);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});
test('unit conflicts, unsafe permissions, symlinks and FIFO fail closed without overwriting', () => {
  const f = setup();
  try {
    const unit = installUserUnit(f); fs.writeFileSync(unit.path, 'conflicting unit');
    assert.throws(() => installUserUnit(f)); assert.equal(fs.readFileSync(unit.path, 'utf8'), 'conflicting unit');
    fs.unlinkSync(unit.path); fs.symlinkSync(f.credentialFile, unit.path);
    assert.throws(() => installUserUnit(f)); assert.equal(fs.readlinkSync(unit.path), f.credentialFile);
    fs.unlinkSync(unit.path); assert.equal(spawnSync('mkfifo', ['-m', '600', unit.path]).status, 0);
    const cli = spawnSync(process.execPath, [new URL('../scripts/node-user-service.mjs', import.meta.url).pathname, '--installation', f.installation, '--unit-directory', f.unitDirectory], { encoding: 'utf8', timeout: 5000 });
    assert.equal(cli.status, 2); assert.equal((cli.stdout + cli.stderr).includes(f.credential.token), false);
    fs.unlinkSync(unit.path); fs.chmodSync(f.unitDirectory, 0o755); assert.throws(() => installUserUnit(f));
    fs.chmodSync(f.unitDirectory, 0o700); fs.symlinkSync(f.unitDirectory, join(f.directory, 'units-link'));
    assert.throws(() => installUserUnit({ ...f, unitDirectory: join(f.directory, 'units-link') }));
    assert.deepEqual(fs.readdirSync(f.unitDirectory), []);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('noncanonical and systemd injection paths are rejected before writing units', () => {
  for (const name of ['with space', 'percent%h', 'dollar$HOME', 'line\nRestart=always', 'quote"']) {
    const f = setup('observe', name);
    try { assert.throws(() => installUserUnit(f)); assert.deepEqual(fs.readdirSync(f.unitDirectory), []); }
    finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
  const f = setup('observe');
  try {
    assert.throws(() => userUnit({ installation: 'relative-installation' }));
    assert.throws(() => installUserUnit({ ...f, installation: f.installation + '/.' }));
    fs.renameSync(join(f.installation, 'complete.json'), join(f.directory, 'preserved-complete'));
    assert.throws(() => installUserUnit(f)); assert.deepEqual(fs.readdirSync(f.unitDirectory), []);
    assert.equal(fs.existsSync(join(f.installation, 'complete.json')), false);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
