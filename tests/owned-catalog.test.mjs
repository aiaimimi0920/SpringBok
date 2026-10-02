import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectOwnedCatalog } from '../src/owned-catalog.mjs';
const fixture = () => JSON.parse(readFileSync(new URL('../catalog/owned-services.json', import.meta.url), 'utf8'));
const product = (f, id) => f.products.find(p => p.id === id);
function rejected(change) { const f = fixture(); change(f); assert.throws(() => inspectOwnedCatalog(f), /^Error: invalid owned-service catalog$/); }
test('real product inputs remain blocked and optional Crow does not block selected products', () => {
  const f = fixture(), before = structuredClone(f), result = inspectOwnedCatalog(f);
  assert.deepEqual(f, before); assert.equal(result.executionReady, false); assert.equal(result.executable, false);
  assert.equal(result.rows.filter(r => r.status === 'blocked').length, 4);
  assert.deepEqual(result.rows.find(r => r.id === 'crow'), { id: 'crow', status: 'not-selected', reasons: [] });
  product(f, 'crow').selected = true;
  const next = inspectOwnedCatalog(f); assert.deepEqual(next.rows.filter(r => r.id !== 'crow'), result.rows.filter(r => r.id !== 'crow'));
  assert.ok(next.rows.find(r => r.id === 'crow').reasons.includes('independent-read-only-query-runtime-missing'));
});
test('canonical order is stable but source, health and dependency changes invalidate digest', () => {
  const f = fixture(), first = inspectOwnedCatalog(f);
  f.products.reverse(); for (const p of f.products) { p.components.reverse(); p.dependencies.reverse(); for (const c of p.components) { c.requires.reverse(); c.dependsOn.reverse(); } }
  assert.deepEqual(inspectOwnedCatalog(f), first);
  for (const change of [f => product(f, 'gateway').source.commit = 'a'.repeat(40), f => product(f, 'gateway').components[0].health.readiness = '/other', f => product(f, 'gateway').dependencies[0].secretRefs.push('gateway.other')]) {
    const changed = fixture(); change(changed); assert.notEqual(inspectOwnedCatalog(changed).catalogDigest, first.catalogDigest);
  }
});
test('unknown, duplicate or omitted products and missing migration components fail closed', () => {
  rejected(f => f.products.pop()); rejected(f => f.products[0].id = 'forum'); rejected(f => f.products[1] = f.products[0]);
  rejected(f => product(f, 'platform').components.shift()); rejected(f => product(f, 'platform').components.find(c => c.id === 'account-api').dependsOn = []);
  rejected(f => product(f, 'gateway').selected = false);
});
test('dangling dependencies and cycles fail including disabled Crow', () => {
  rejected(f => product(f, 'gateway').components[0].dependsOn = ['missing']);
  rejected(f => product(f, 'gateway').components[0].requires = ['missing']);
  rejected(f => product(f, 'platform').components.find(c => c.id === 'core-migrate').dependsOn = ['account-api']);
  rejected(f => product(f, 'crow').components[0].dependsOn = ['query-api']);
});
test('runtime claims, bindings, mutable pins and credential values are not catalog fields', () => {
  rejected(f => f.executionReady = true); rejected(f => product(f, 'gateway').ready = true);
  rejected(f => product(f, 'gateway').components[0].binding = { deploymentId: 'a'.repeat(24) });
  rejected(f => product(f, 'gateway').source.commit = 'latest');
  rejected(f => product(f, 'gateway').source.repository = 'https://user:password@example.invalid/repo');
  rejected(f => product(f, 'gateway').dependencies[0].value = 'DO-NOT-ECHO');
  rejected(f => product(f, 'gateway').dependencies[0].secretRefs = ['postgres://secret@example.invalid/db']);
  rejected(f => product(f, 'gateway').components[0].command = 'anything');
  rejected(f => product(f, 'gateway').components[0].sourcePath = '../private');
});
test('CLI reads its fixed catalog without accepting alternate paths or executing anything', () => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-catalog-test-'));
  let run;
  try {
    run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/owned-catalog.mjs', import.meta.url))], { encoding: 'utf8', cwd: directory });
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true }); }
  assert.equal(run.status, 0); assert.equal(run.stderr, ''); assert.deepEqual(JSON.parse(run.stdout), inspectOwnedCatalog(fixture()));
  const bad = spawnSync(process.execPath, ['scripts/owned-catalog.mjs', '/DO-NOT-ECHO'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.equal(bad.stderr.includes('DO-NOT-ECHO'), false);
});

test('coercible IDs and delimiter-colliding object keys cannot satisfy the schema', () => {
  rejected(f => { f.products = Array.from({ length: 5 }, () => ({ ...structuredClone(f.products[0]), id: ['gateway'] })); });
  for (const id of [['gateway'], { toString: 'gateway' }, 1, null]) rejected(f => f.products[0].id = id);
  rejected(f => product(f, 'gateway').components[0].health = { 'liveness,readiness': '/ok' });
  rejected(f => { const p = product(f, 'gateway'); p.source = { 'commit,repository': 'ignored' }; });
  rejected(f => { f['kind,products'] = f.kind; delete f.kind; delete f.products; });
});

test('separate Rauthy target and verified managed PostgreSQL remain unbound requirements', () => {
  const output = inspectOwnedCatalog(fixture()), r = product(output.catalog, 'rauthy'), p = product(output.catalog, 'platform');
  assert.equal(p.source.commit, '6512fd2d1f8781001dc83500a65d134b32907a62');
  assert.deepEqual(p.components.find(c => c.id === 'account-api').requires, ['cache', 'database', 'issuer-config']);
  assert.deepEqual(p.components.find(c => c.id === 'web').requires, ['identity', 'issuer-config']);
  assert.deepEqual(r.dependencies.find(d => d.id === 'external-managed-postgres').policy, { hiqlite: false, tls: 'require', verifyCertificate: true, caRef: 'rauthy.postgres-ca' });
  assert.ok(output.rows.find(r => r.id === 'rauthy').reasons.includes('independent-identity-host-unbound'));
  for (const change of [f => product(f, 'platform').components.find(c => c.id === 'account-api').requires = ['database', 'identity'], f => product(f, 'platform').dependencies.find(d => d.id === 'issuer-config').secretRefs = ['rauthy.private-key'], f => product(f, 'rauthy').dependencies.find(d => d.id === 'independent-runtime').kind = 'volume']) rejected(change);
  for (const [key, value] of [['tls', 'prefer'], ['verifyCertificate', false], ['hiqlite', true], ['caRef', 'literal-certificate']]) rejected(f => product(f, 'rauthy').dependencies.find(d => d.id === 'external-managed-postgres').policy[key] = value);
  rejected(f => product(f, 'platform').components.find(c => c.id === 'web').dependsOn.push('rauthy'));
});

test('identity dependency kinds and exact secret ownership cannot be reassigned or omitted', () => {
  const dependency = (f, id, dep) => product(f, id).dependencies.find(d => d.id === dep);
  for (const [id, dep, refs] of [
    ['rauthy', 'external-managed-postgres', ['platform.database']],
    ['rauthy', 'identity-secrets', ['platform.oidc-client']],
    ['rauthy', 'identity-secrets', []],
    ['rauthy', 'external-managed-postgres', []],
    ['platform', 'database', ['platform.database', 'platform.oidc-client']],
    ['platform', 'identity', []],
  ]) rejected(f => dependency(f, id, dep).secretRefs = refs);
  rejected(f => dependency(f, 'platform', 'cache').kind = 'identity');
  rejected(f => dependency(f, 'rauthy', 'login-domain').kind = 'volume');
  rejected(f => product(f, 'platform').dependencies.push({ id: 'extra', kind: 'identity', secretRefs: ['platform.oidc-client'], binding: null }));
  rejected(f => product(f, 'rauthy').dependencies.find(d => d.id === 'login-domain').id = 'unknown-domain');
});
