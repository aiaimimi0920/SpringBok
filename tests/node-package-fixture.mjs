import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildNodePackage } from '../src/node-install/package.mjs';

export const root = new URL('../', import.meta.url);
// 仅测试构建器的合成 revision；正式 CLI 必须从 Git HEAD 读取已提交文件。
export const fixtureRevision = 'a'.repeat(40);
export function packageFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-install-'));
  const packageDirectory = join(directory, 'package');
  const built = buildNodePackage({ directory: packageDirectory, revision: fixtureRevision, readSource: path => readFileSync(new URL(path, root), 'utf8') });
  return { directory, packageDirectory, built };
}
export function roleFixture(directory, role = 'execute') {
  const credential = { protocolVersion: 2, origin: 'https://control.example.invalid', ownerId: 'b'.repeat(64), nodeId: randomUUID(), enrollmentId: randomUUID(), role, token: randomBytes(32).toString('hex') };
  const credentialFile = join(directory, `${role}.json`);
  writeFileSync(credentialFile, JSON.stringify(credential), { flag: 'wx', mode: 0o600 });
  return { credentialFile, credential };
}
