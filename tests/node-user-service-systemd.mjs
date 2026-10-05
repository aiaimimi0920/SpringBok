import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installNode } from '../src/node-install/install.mjs';
import { installUserUnit } from '../src/node-service/user-unit.mjs';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';

assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0);
assert.equal(process.env.SPRINGBOK_DISPOSABLE_SYSTEMD_CI, '1', 'only run in an isolated disposable CI account');
const run = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const systemctl = (...args) => run('systemctl', ['--user', ...args], { timeout: 45000 });
const root = join(homedir(), 'springbok-systemd-evidence'), recordPath = join(root, 'restart.json');
const unitDirectory = join(homedir(), '.config/systemd/user');
async function until(predicate) {
  const end = Date.now() + 20000;
  do { if (await predicate()) return; await wait(100); } while (Date.now() < end);
  throw new Error('systemd acceptance timeout');
}
function events(f) { return fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; }
async function state(f) {
  const { stdout } = await systemctl('show', f.name, '--property=ActiveState,SubState,Result,MainPID,ExecMainStatus,NRestarts,UnitFileState');
  return Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
}
function configure(f, mode) { fs.writeFileSync(f.config, JSON.stringify({ credential: f.credential, mode, log: f.log }), { mode: 0o600 }); }
async function stopped(f, failed = false) {
  await until(async () => (await state(f)).ActiveState === (failed ? 'failed' : 'inactive'));
  const s = await state(f); assert.equal(s.NRestarts, '0'); assert.equal(s.MainPID, '0');
  assert.equal(s.ExecMainStatus, failed ? '2' : '0');
}
// 新 unit 尚未加载时按名称 reset-failed 会被真实 manager 拒绝。
// 仅此一次性专属测试账户重置 manager 的失败计数；不处理 ledger/锁。
async function start(f) { await systemctl('reset-failed'); await systemctl('start', f.name); }
function fixture(role) {
  const f = packageFixture(), r = roleFixture(f.directory, role), installation = join(f.directory, 'installed');
  installNode({ packageDirectory: f.packageDirectory, expectedSha256: f.built.sha256, credentialFile: r.credentialFile, expectedOrigin: r.credential.origin, role, directory: installation });
  const unit = installUserUnit({ installation, unitDirectory });
  const result = { ...r, installation, name: unit.name, log: join(f.directory, 'fetch.log'), config: join(f.directory, 'fetch.json') };
  configure(result, 'normal');
  const dropin = join(unitDirectory, `${unit.name}.d`); fs.mkdirSync(dropin, { mode: 0o700 });
  const preload = fileURLToPath(new URL('./node-user-service-fetch-fixture.mjs', import.meta.url));
  // 只向此一次性账户的测试 unit 注入合成传输；生产 unit/包保持原样。
  fs.writeFileSync(join(dropin, 'test-transport.conf'), `[Service]\nEnvironment=NODE_OPTIONS=--import=${preload}\nEnvironment=SPRINGBOK_SYSTEMD_TEST_CONFIG=${result.config}\n`, { mode: 0o600, flag: 'wx' });
  return result;
}
const phase = process.argv[2];
if (phase === 'exercise') {
  fs.mkdirSync(root, { mode: 0o700 });
  const { stdout: environment } = await systemctl('show-environment');
  console.log('isolated manager environment: ' + environment.split('\n').filter(line => /^(HOME|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=/.test(line)).join(' '));
  const fixtures = ['execute', 'observe'].map(fixture);
  await systemctl('daemon-reload');
  for (const f of fixtures) {
    await start(f); await until(() => events(f).some(e => e.event === 'response' && e.heartbeat && e.operation === 'sample'));
    assert.equal((await state(f)).ActiveState, 'active');
    await systemctl('stop', f.name); await stopped(f);
    assert.equal(fs.existsSync(join(f.installation, 'state/daemon.lock')), false);
    const count = events(f).length; configure(f, 'delay');
    await start(f); await until(() => events(f).length === count + 1);
    await systemctl('stop', f.name); await stopped(f);
    assert.equal(events(f).length, count + 2, 'stop drains the actual in-flight request');
    assert.equal(events(f).at(-1).event, 'response');
    assert.equal(fs.existsSync(join(f.installation, 'state/daemon.lock')), false);
    configure(f, 'denied'); await start(f); await stopped(f, true);
    const failedCount = events(f).length; await wait(500);
    assert.equal(events(f).length, failedCount); assert.equal((await state(f)).NRestarts, '0');
    const { stdout: journal } = await run('journalctl', ['--user', '-u', f.name, '--no-pager', '-o', 'cat'], { timeout: 10000 });
    assert.equal(journal.includes(f.credential.token), false); assert.match(journal, /"event":"stopping"/); assert.match(journal, /"event":"stopped"/);
    fs.writeFileSync(join(root, `${f.credential.role}-journal.txt`), journal, { mode: 0o600 });
  }
  const execute = fixtures[0]; configure(execute, 'unknown'); await start(execute); await stopped(execute, true);
  const ledger = fs.readFileSync(join(execute.installation, 'state/ledger.json')), count = events(execute).length;
  await start(execute); await stopped(execute, true);
  assert.equal(events(execute).length, count); assert.deepEqual(fs.readFileSync(join(execute.installation, 'state/ledger.json')), ledger);
  await systemctl('stop', execute.name);
  const observe = fixtures[1]; configure(observe, 'normal'); await systemctl('reset-failed');
  await systemctl('enable', observe.name); assert.equal((await state(observe)).UnitFileState, 'enabled');
  fs.writeFileSync(recordPath, JSON.stringify({ ...observe, count: events(observe).length }), { mode: 0o600, flag: 'wx' });
  console.log('systemd exercise passed: dual roles, actual daemon, drain, identity failure, unknown preservation, no restart, enable');
} else if (phase === 'restart') {
  const f = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  await until(() => events(f).length >= f.count + 2);
  const s = await state(f); assert.equal(s.ActiveState, 'active'); assert.equal(s.UnitFileState, 'enabled'); assert.equal(s.NRestarts, '0');
  await systemctl('stop', f.name); await stopped(f); await systemctl('disable', f.name);
  assert.equal((await state(f)).UnitFileState, 'disabled');
  fs.writeFileSync(recordPath, JSON.stringify({ ...f, count: events(f).length }), { mode: 0o600 });
  console.log('systemd manager recreation passed: enabled default.target starts the installed daemon; explicit stop/disable passed');
} else if (phase === 'disabled') {
  const f = JSON.parse(fs.readFileSync(recordPath, 'utf8')); await wait(500);
  assert.equal((await state(f)).ActiveState, 'inactive'); assert.equal(events(f).length, f.count);
  await start(f); await until(() => events(f).length >= f.count + 2);
  await systemctl('kill', '--signal=SIGKILL', '--kill-whom=all', f.name);
  await until(async () => (await state(f)).ActiveState === 'failed');
  const lock = join(f.installation, 'state/daemon.lock'), bytes = fs.readFileSync(lock), count = events(f).length;
  await wait(500); assert.equal((await state(f)).NRestarts, '0'); assert.deepEqual(fs.readFileSync(lock), bytes);
  await start(f); await stopped(f, true); assert.equal(events(f).length, count); assert.deepEqual(fs.readFileSync(lock), bytes);
  await systemctl('stop', f.name);
  console.log('systemd disabled recreation and SIGKILL passed: no autostart, no automatic restart, stale lock preserved and explicit restart refused');
} else throw new Error('expected exercise|restart|disabled');
