import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installNode, verifyInstallation } from '../src/node-install/install.mjs';
import { PACKAGE_FILES } from '../src/node-install/package.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';

function setup(role = 'execute') {
  assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0, 'run installation tests as a non-root Linux uid');
  const f = packageFixture(), r = roleFixture(f.directory, role);
  return { ...f, ...r, options: { packageDirectory: f.packageDirectory, expectedSha256: f.built.sha256, credentialFile: r.credentialFile, expectedOrigin: r.credential.origin, role, directory: join(f.directory, 'installed') } };
}
function run(f, action) { return spawnSync(process.execPath, [join(f.options.directory, 'release/scripts/node-run.mjs'), '--installation', f.options.directory, '--action', action], { encoding: 'utf8', timeout: 10000 }); }
function snapshotFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd); assert.ok(stat.isFile());
    return { ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(fd) };
  } finally { fs.closeSync(fd); }
}

test('single-role installation is private, runnable and idempotent without touching its credential or ledger', () => {
  const f = setup();
  try {
    assert.equal(installNode(f.options).status, 'installed');
    const installed = verifyInstallation(f.options.directory);
    const ledger = join(installed.stateDirectory, 'ledger.json'); fs.writeFileSync(ledger, 'preserve unknown evidence', { mode: 0o600 });
    const before = snapshotFile(installed.credentialFile);
    assert.equal(installNode(f.options).status, 'verified');
    assert.deepEqual(snapshotFile(installed.credentialFile), before);
    assert.equal(fs.readFileSync(ledger, 'utf8'), 'preserve unknown evidence');
    for (const p of ['credential.json', 'install.json', 'complete.json', 'release/scripts/node-run.mjs']) assert.equal(fs.statSync(join(f.options.directory, p)).mode & 0o077, 0);
    for (const p of ['', 'release', 'release/scripts', 'state']) assert.equal(fs.statSync(join(f.options.directory, p)).mode & 0o077, 0);
    const cli = run(f, 'version'); assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).revision, f.built.revision); assert.equal(cli.stdout.includes(f.credential.token), false);
    const probe = run(f, 'probe'); assert.equal(probe.status, 1); assert.equal((probe.stdout + probe.stderr).includes(f.credential.token), false); assert.equal(fs.readFileSync(ledger, 'utf8'), 'preserve unknown evidence');
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('complete installations never repair missing files, recreate state or overwrite conflicts', () => {
  for (const relative of ['credential.json', 'release/manifest.json', 'release/scripts/node-run.mjs', 'state']) {
    const f = setup();
    try {
      installNode(f.options); const missing = join(f.options.directory, relative);
      fs.renameSync(missing, join(f.directory, 'preserved-original'));
      assert.throws(() => installNode(f.options), `must not repair ${relative}`); assert.equal(fs.existsSync(missing), false);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
  const f = setup();
  try {
    installNode(f.options); const file = join(f.options.directory, 'credential.json'); fs.writeFileSync(file, '{}');
    assert.throws(() => installNode(f.options)); assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('an exact pending installation resumes without changing existing files and refuses conflicting partial state', () => {
  const f = setup();
  try {
    installNode(f.options);
    const complete = join(f.options.directory, 'complete.json'), file = join(f.options.directory, 'release', PACKAGE_FILES[0]);
    const credential = join(f.options.directory, 'credential.json'), before = fs.statSync(credential).mtimeMs;
    fs.unlinkSync(complete); fs.unlinkSync(file); // 确定的半完成故障夹具，不是生产恢复建议。
    const ledger = join(f.options.directory, 'state/ledger.json'); fs.writeFileSync(ledger, 'do not reset', { mode: 0o600 });
    assert.equal(installNode(f.options).status, 'installed'); assert.equal(fs.statSync(credential).mtimeMs, before); assert.equal(fs.readFileSync(ledger, 'utf8'), 'do not reset');
    fs.unlinkSync(complete); fs.writeFileSync(file, 'conflict'); assert.throws(() => installNode(f.options)); assert.equal(fs.existsSync(complete), false); assert.equal(fs.readFileSync(file, 'utf8'), 'conflict');
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('untrusted origin, digest, role, permissions and symlinks fail closed before destination creation', () => {
  const f = setup();
  try {
    for (const extra of [{ expectedOrigin: 'https://attacker.example.invalid' }, { expectedOrigin: 'http://control.example.invalid' }, { expectedSha256: '0'.repeat(64) }, { role: 'observe' }]) {
      assert.throws(() => installNode({ ...f.options, ...extra })); assert.equal(fs.existsSync(f.options.directory), false);
    }
    fs.chmodSync(f.credentialFile, 0o644); assert.throws(() => installNode(f.options)); fs.chmodSync(f.credentialFile, 0o600);
    fs.symlinkSync(f.credentialFile, join(f.directory, 'link')); assert.throws(() => installNode({ ...f.options, credentialFile: join(f.directory, 'link') }));
    const fifo = join(f.directory, 'credential-fifo'); assert.equal(spawnSync('mkfifo', ['-m', '600', fifo]).status, 0);
    const rejected = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/node-install.mjs', import.meta.url)), '--package', f.packageDirectory, '--sha256', f.built.sha256, '--credential', fifo, '--expected-origin', f.credential.origin, '--role', 'execute', '--directory', f.options.directory], { encoding: 'utf8', timeout: 5000 });
    assert.equal(rejected.status, 1, 'non-regular credential must reject without blocking in open'); assert.match(rejected.stderr, /Node installation rejected/);
    fs.symlinkSync(f.packageDirectory, join(f.directory, 'package-link')); assert.throws(() => installNode({ ...f.options, packageDirectory: join(f.directory, 'package-link') }));
    const nested = join(f.packageDirectory, PACKAGE_FILES[0]), original = fs.readFileSync(nested); fs.unlinkSync(nested); fs.symlinkSync(f.credentialFile, nested);
    assert.throws(() => installNode(f.options)); fs.unlinkSync(nested); fs.writeFileSync(nested, original);
    assert.equal(fs.existsSync(f.options.directory), false);
    fs.mkdirSync(f.options.directory, { mode: 0o700 }); assert.throws(() => installNode(f.options)); assert.deepEqual(fs.readdirSync(f.options.directory), []);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('observe package runs version but refuses probe before opening a journal', () => {
  const f = setup('observe');
  try {
    const installer = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/node-install.mjs', import.meta.url)), '--package', f.packageDirectory, '--sha256', f.built.sha256, '--credential', f.credentialFile, '--expected-origin', f.credential.origin, '--role', 'observe', '--directory', f.options.directory], { encoding: 'utf8', timeout: 10000 });
    assert.equal(installer.status, 0, installer.stderr); assert.equal(JSON.parse(installer.stdout).role, 'observe');
    assert.equal(run(f, 'version').status, 0); const probe = run(f, 'probe'); assert.equal(probe.status, 1); assert.equal((probe.stdout + probe.stderr).includes(f.credential.token), false);
    assert.deepEqual(fs.readdirSync(join(f.options.directory, 'state')), []);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
