import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileConfiguration } from '../src/config/compile.mjs';
const example = () => JSON.parse(readFileSync(new URL('../examples/config/services.json', import.meta.url)));
const schema = JSON.parse(readFileSync(new URL('./fixtures/komodo-deployment-2.3.3.json', import.meta.url)));
const one = () => { const m = example(); m.services = [m.services[1]]; return m; };
const cli = file => spawnSync(process.execPath, ['scripts/config.mjs', file], { encoding: 'utf8', timeout: 3000 });
test('user manifest compiles deterministically without mutation, connection or approval', () => {
  const m = example(), before = structuredClone(m), result = compileConfiguration(m);
  assert.deepEqual(m, before); assert.equal(result.drafts.length, 8); assert.equal(result.readiness, false); assert.equal(result.executable, false);
  assert.equal(result.komodoVersion, '2.3.3'); assert.deepEqual(result.omittedServices, []);
  m.services.reverse(); for (const s of m.services) { s.test.ports.reverse(); s.production.volumes.reverse(); }
  assert.deepEqual(compileConfiguration(m), result);
  m.services[0].image = m.services[0].image.replace(/.$/, 'f'); assert.notEqual(compileConfiguration(m).manifestDigest, result.manifestDigest);
});
test('one service is useful without placeholders; secrets stay unresolved and affect manifest binding', () => {
  const m = one(), result = compileConfiguration(m);
  assert.equal(result.drafts.length, 2); assert.deepEqual(result.omittedServices, ['gateway', 'game', 'account']);
  const draft = result.drafts[0]; assert.equal(draft.config.environment, ''); assert.equal(draft.config.skip_secret_interp, true);
  assert.ok(draft.requirements.includes('resolve-secret-references-through-approved-channel'));
  m.services[0].test.secretRefs[0].reference = 'different-reference';
  const changed = compileConfiguration(m); assert.notEqual(changed.manifestDigest, result.manifestDigest);
  assert.equal(changed.drafts[0].configDigest, draft.configDigest); // Partial config deliberately omits unresolved secrets.
});
test('export matches the pinned official PartialDeploymentConfig field types', () => {
  for (const draft of compileConfiguration(example()).drafts) {
    assert.deepEqual(Object.keys(draft.config).sort(), Object.keys(schema.properties).sort());
    for (const [key, value] of Object.entries(draft.config)) {
      const spec = schema.properties[key];
      if (key === 'image') { assert.equal(value.type, 'Image'); assert.match(value.params.image, /@sha256:[a-f0-9]{64}$/); }
      else if (key === 'restart') assert.ok(schema.definitions.RestartMode.enum.includes(value));
      else if (key === 'extra_args') assert.deepEqual(value, []);
      else assert.ok([].concat(spec.type).includes(typeof value), key);
    }
    assert.equal(draft.config.network, 'bridge'); assert.equal(draft.config.command, '');
    assert.equal(draft.config.auto_update, false); assert.equal(draft.config.image_registry_account, '');
  }
});
test('ports and named volumes produce the exact Komodo conversion strings, not commands', () => {
  const m = one(); m.services[0].test.ports = [{ hostIp: '0.0.0.0', hostPort: 9000, containerPort: 7000, protocol: 'udp' }];
  m.services[0].test.volumes[0].readOnly = true;
  const draft = compileConfiguration(m).drafts[0];
  assert.equal(draft.config.ports, '0.0.0.0:9000:7000/udp');
  assert.equal(draft.config.volumes, 'forum-test-data:/data:ro');
  assert.ok(draft.requirements.includes('review-external-network-exposure'));
  assert.ok(draft.requirements.includes('verify-volume-provisioning-ownership-backups-and-data-migration'));
});
test('per-server TCP/UDP allocation catches wildcard and loopback overlap', () => {
  const m = one(), s = m.services[0]; s.production.serverId = s.test.serverId;
  assert.throws(() => compileConfiguration(m), /overlaps/);
  s.production.ports[0].hostIp = '0.0.0.0'; assert.throws(() => compileConfiguration(m), /overlaps/);
  s.production.ports[0].protocol = 'udp'; assert.equal(compileConfiguration(m).drafts.length, 2);
  s.test.ports[0].hostIp = '0.0.0.0'; s.production.ports[0].hostIp = '127.0.0.1'; s.production.ports[0].protocol = 'tcp';
  assert.throws(() => compileConfiguration(m), /overlaps/);
});
test('target, service, shared volume and nested mount ambiguities are rejected', () => {
  const m = one(), s = m.services[0]; s.production.deploymentName = s.test.deploymentName;
  assert.throws(() => compileConfiguration(m), /unique/); s.production.deploymentName = 'forum-prod';
  s.production.serverId = s.test.serverId; s.production.ports = []; s.production.volumes = structuredClone(s.test.volumes);
  assert.throws(() => compileConfiguration(m), /volume reused/);
  s.production.volumes = []; s.test.volumes.push({ name: 'nested-data', containerPath: '/data/files', readOnly: true });
  assert.throws(() => compileConfiguration(m), /overlapping container/);
  const duplicate = one(); duplicate.services.push(structuredClone(duplicate.services[0])); assert.throws(() => compileConfiguration(duplicate), /duplicate/);
});
test('mutable images, injected values, host paths, extra commands and inline secrets fail closed', () => {
  const mutations = [
    m => { m.services[0].image = 'ghcr.io/org/forum:latest'; },
    m => { m.services[0].image = 'user:password@ghcr.io/org/forum@sha256:' + '1'.repeat(64); },
    m => { m.services[0].image = 'ghcr.io/org/forum@sha256:' + '1'.repeat(64) + ';id'; },
    m => { m.services[0].test.deploymentName = 'name$(id)'; },
    m => { m.services[0].test.volumes[0].name = '/host/path'; },
    m => { m.services[0].test.volumes[0].containerPath = '/data/../proc'; },
    m => { m.services[0].test.volumes[0].containerPath = '/var/run/docker.sock'; },
    m => { m.services[0].test.command = 'echo PRIVATE'; },
    m => { m.services[0].test.secretRefs[0].value = 'PRIVATE'; },
    m => { m.services[0].test.secretRefs[0].reference = 'https://PRIVATE'; },
    m => { m.services[0].test.ports[0].hostPort = '8080'; },
    m => { m.services[0].test.ports[0].containerPort = 65536; },
    m => { m.services = []; },
  ];
  for (const mutate of mutations) { const m = one(); mutate(m); assert.throws(() => compileConfiguration(m), error => !error.message.includes('PRIVATE')); }
});
test('CLI emits bounded review JSON without changing input or creating files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'input.json'), content = JSON.stringify(one()); writeFileSync(file, content);
  const result = cli(file); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), compileConfiguration(one())); assert.equal(readFileSync(file, 'utf8'), content);
  assert.deepEqual(readdirSync(directory), ['input.json']);
});
test('CLI rejects invalid/oversized/symlink input without echoing source or partial output', t => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-invalid-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'input.json');
  for (const content of ['{"PRIVATE":', JSON.stringify({ PRIVATE: 'SECRET' }), ' '.repeat(65537), Buffer.from([0xff])]) {
    writeFileSync(file, content); const result = cli(file); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /PRIVATE|SECRET|springbok-invalid/);
  }
  const link = join(directory, 'link.json'); symlinkSync(file, link); assert.equal(cli(link).status, 1);
});
