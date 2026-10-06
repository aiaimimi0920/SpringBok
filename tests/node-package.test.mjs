import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_FILES, buildNodePackage, verifyPackage, sha256, jsonBytes } from '../src/node-install/package.mjs';
import { packageFixture, fixtureRevision, root } from './node-package-fixture.mjs';

test('control package is deterministic, closed over local imports and runnable without npm dependencies', () => {
  const f = packageFixture();
  try {
    const verified = verifyPackage(f.packageDirectory, f.built.sha256);
    assert.equal(verified.metadata.revision, fixtureRevision);
    assert.equal(verified.files.length, PACKAGE_FILES.length);
    for (const { path, data } of verified.files) {
      assert.equal(data.includes(Buffer.from('\r\n')), false);
      for (const [, imported] of data.toString().matchAll(/from ['"]([^'"]+)['"]/g)) {
        if (imported.startsWith('node:')) continue;
        assert.ok(imported.startsWith('.'), `unexpected dependency: ${imported}`);
        assert.ok(PACKAGE_FILES.includes(posix.normalize(posix.join(posix.dirname(path), imported))), `missing import: ${path} -> ${imported}`);
      }
    }
    const second = buildNodePackage({ directory: join(f.directory, 'second'), revision: fixtureRevision, readSource: path => fs.readFileSync(new URL(path, root), 'utf8') });
    assert.equal(second.sha256, f.built.sha256);
    assert.throws(() => buildNodePackage({ directory: f.packageDirectory, revision: fixtureRevision, readSource: path => fs.readFileSync(new URL(path, root), 'utf8') }));
    const cli = spawnSync(process.execPath, [join(f.packageDirectory, 'scripts/node-run.mjs')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(cli.status, 1); assert.match(cli.stderr, /Installed node action rejected/); assert.doesNotMatch(cli.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('package rejects untrusted digest, bytes, manifest schema and extra paths including empty directories', () => {
  const f = packageFixture();
  try {
    assert.throws(() => verifyPackage(f.packageDirectory, '0'.repeat(64)));
    const file = join(f.packageDirectory, PACKAGE_FILES[0]), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n'); assert.throws(() => verifyPackage(f.packageDirectory, f.built.sha256)); fs.writeFileSync(file, original);
    fs.mkdirSync(join(f.packageDirectory, 'unexpected')); assert.throws(() => verifyPackage(f.packageDirectory, f.built.sha256)); fs.rmdirSync(join(f.packageDirectory, 'unexpected'));
    fs.writeFileSync(join(f.packageDirectory, 'unexpected.txt'), 'extra'); assert.throws(() => verifyPackage(f.packageDirectory, f.built.sha256)); fs.unlinkSync(join(f.packageDirectory, 'unexpected.txt'));
    const manifestFile = join(f.packageDirectory, 'manifest.json'), bytes = fs.readFileSync(manifestFile), metadata = JSON.parse(bytes);
    for (const change of [{ ...metadata, format: 'springbok-control-node/v1' }, { ...metadata, format: 'springbok-control-node/v2' }, { ...metadata, format: 'springbok-control-node/v3' }, { ...metadata, format: 'springbok-control-node/v4' }, { ...metadata, format: 'springbok-control-node/v5' }, { ...metadata, format: 'springbok-control-node/v6' }, { ...metadata, revision: 'dirty' }, { ...metadata, minimumNodeMajor: 0 }, { ...metadata, extra: true }, { ...metadata, files: metadata.files.map((v, i) => i ? v : { ...v, path: '../outside' }) }]) {
      const changed = jsonBytes(change); fs.writeFileSync(manifestFile, changed); assert.throws(() => verifyPackage(f.packageDirectory, sha256(changed)));
    }
    fs.writeFileSync(manifestFile, bytes); verifyPackage(f.packageDirectory, f.built.sha256);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
