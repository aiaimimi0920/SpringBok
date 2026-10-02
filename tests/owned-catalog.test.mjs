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
