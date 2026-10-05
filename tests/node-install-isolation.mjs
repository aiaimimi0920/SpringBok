// 只在一次性 Linux 容器内以 root 启动的验收工具；产品安装器本身拒绝 root。
// 使用数字 uid/gid 子进程，不创建系统账号，不挂载或修改宿主凭据/服务。
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageFixture, roleFixture } from './node-package-fixture.mjs';
import { installNode } from '../src/node-install/install.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
assert.ok(fs.existsSync('/.dockerenv'), 'run only in a disposable Docker test container');
const p = packageFixture();
try {
  fs.chmodSync(p.directory, 0o755);
  const roles = ['execute', 'observe'], installations = [];
  const script = fileURLToPath(new URL('../scripts/node-install.mjs', import.meta.url));
  for (const [index, role] of roles.entries()) {
    const uid = 11001 + index, home = join(p.directory, role); fs.mkdirSync(home, { mode: 0o700 }); fs.chownSync(home, uid, uid);
    const r = roleFixture(home, role); fs.chownSync(r.credentialFile, uid, uid);
    const directory = join(home, 'installed');
    const options = { packageDirectory: p.packageDirectory, expectedSha256: p.built.sha256, credentialFile: r.credentialFile, expectedOrigin: r.credential.origin, role, directory };
    assert.throws(() => installNode(options)); assert.equal(fs.existsSync(directory), false);
    const args = [script, '--package', p.packageDirectory, '--sha256', p.built.sha256, '--credential', r.credentialFile, '--expected-origin', r.credential.origin, '--role', role, '--directory', directory];
    const installed = spawnSync(process.execPath, args, { uid, gid: uid, encoding: 'utf8', timeout: 10000 }); assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).role, role);
    const journal = join(directory, 'state/ledger.json'); fs.writeFileSync(journal, 'private test evidence', { mode: 0o600 }); fs.chownSync(journal, uid, uid);
    const version = spawnSync(process.execPath, [join(directory, 'release/scripts/node-run.mjs'), '--installation', directory, '--action', 'version'], { uid, gid: uid, encoding: 'utf8', timeout: 10000 }); assert.equal(version.status, 0, version.stderr);
    installations.push({ uid, directory, credentialFile: join(directory, 'credential.json'), journal });
  }
  const denied = `import { readFileSync } from 'node:fs'; for (const file of process.argv.slice(1)) { try { readFileSync(file); process.exit(2); } catch (error) { if (error.code !== 'EACCES') throw error; } }`;
  for (const [index, current] of installations.entries()) {
    const other = installations[1 - index];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', denied, other.credentialFile, other.journal], { uid: current.uid, gid: current.uid, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const wrong = spawnSync(process.execPath, [join(other.directory, 'release/scripts/node-run.mjs'), '--installation', other.directory, '--action', 'version'], { uid: current.uid, gid: current.uid, encoding: 'utf8', timeout: 10000 }); assert.notEqual(wrong.status, 0);
  }
  console.log(JSON.stringify({ uidIsolation: 'passed', roles, differentUids: true, credentialAndJournalCrossRead: 'EACCES', rootInstallation: 'rejected', executionReady: false }));
} finally { fs.rmSync(p.directory, { recursive: true, force: true }); }
