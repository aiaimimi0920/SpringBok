import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICES } from '../src/contract.mjs';
import { createCatalog } from '../src/execution/plan.mjs';
import { project } from '../src/execution/projection.mjs';
import { inspectFixtureInventory } from '../src/preview/connection.mjs';
import { previewPlan, PREVIEW_OPERATIONS } from '../src/preview/plan.mjs';
import { previewFixture, fixturePreview, SCENARIOS } from '../src/preview/fixtures.mjs';
import { startDemo } from '../src/demo/server.mjs';

test('all fixed scenarios and operations are read-only projections with no executable result', () => {
  for (const service of SERVICES) for (const scenario of SCENARIOS) for (const operation of PREVIEW_OPERATIONS) {
    const fixture = previewFixture(service, scenario), before = structuredClone(fixture);
    const result = previewPlan({ ...fixture, service, operation });
    assert.deepEqual(fixture, before); assert.equal(result.executable, false);
    assert.equal(result.connection.connected, false); assert.equal(result.connection.executionReady, false);
    assert.deepEqual(result.connection.gates, { authenticatedOwner: false, authenticatedTransport: false, exclusiveConfiguration: false });
    assert.equal(result.mode, 'offline-plan-preview');
    assert.equal(result.history.eventCount, fixture.events.length);
    assert.equal(project(createCatalog(fixture.releases, fixture.manifest), fixture.events).lab.snapshot().services.find(r => r.spec.id === service).phase, result.phase);
  }
});

test('approved v2 preview shows v1-to-v2 differences but requires resource preparation and real authority', () => {
  const result = fixturePreview('gateway', 'approved', 'promote');
  assert.equal(result.phase, 'approved'); assert.equal(result.contractEligible, true);
  assert.equal(result.reason, 'configuration-preparation-required');
  assert.equal(result.current.status, 'fixture-record-and-inventory-match');
  assert.ok(result.changes.every(c => c.changed === true));
  assert.equal(result.changes[0].from, `sha256:${'1'.repeat(64)}`);
  assert.equal(result.changes[0].to, `sha256:${'2'.repeat(64)}`);
  assert.equal(result.plan.name, 'springbok-gateway-production');
  assert.equal(result.executable, false);
});

test('known-good rollback comes from the contract and initial deployment cannot invent one', () => {
  const rollback = fixturePreview('forum', 'live', 'rollback');
  assert.equal(rollback.contractEligible, true); assert.equal(rollback.rollbackAvailable, true);
  assert.equal(rollback.plan.artifact, `sha256:${'1'.repeat(64)}`);
  assert.equal(rollback.current.artifact, `sha256:${'2'.repeat(64)}`);
  assert.equal(fixturePreview('forum', 'live', 'test').rollbackAvailable, true);
  const fresh = fixturePreview('forum', 'fresh', 'rollback');
  assert.equal(fresh.plan, null); assert.equal(fresh.rollbackAvailable, false);
  assert.equal(fresh.reason, 'no-known-good-release');
});

test('unknown submission cannot be shown as current success or usable approval', () => {
  for (const operation of PREVIEW_OPERATIONS) {
    const result = fixturePreview('game', 'unknown', operation);
    assert.equal(result.reason, 'unresolved-execution'); assert.equal(result.contractEligible, false);
    assert.equal(result.rollbackAvailable, false); assert.equal(result.current.status, 'unknown');
    assert.equal(result.current.artifact, null); assert.equal(result.executable, false);
    assert.ok(result.changes.every(c => c.changed === null && c.from === null));
  }
});

test('fixture connection data rejects identity/version/capability escapes and never returns unknown configuration', () => {
  const f = previewFixture('gateway', 'approved'), catalog = createCatalog(f.releases, f.manifest);
  for (const change of [i => { i.version = 'other'; }, i => { i.source = 'production'; }, i => { i.url = 'https://example.com'; },
    i => { i.credentials = 'never-accepted'; }, i => { i.resources[0].id = 'f'.repeat(24); },
    i => { i.resources[1] = i.resources[0]; }, i => { i.resources[0].name = 'foreign-target'; }]) {
    const inventory = structuredClone(f.inventory); change(inventory);
    assert.throws(() => inspectFixtureInventory(catalog, f.releases, inventory));
  }
  const target = f.inventory.resources.find(r => r.name === 'springbok-gateway-production');
  target.config.environment = 'SYNTHETIC_PRIVATE_BACKEND_VALUE';
  const result = previewPlan({ ...f, service: 'gateway', operation: 'promote' });
  assert.equal(result.reason, 'inventory-unknown'); assert.equal(result.current.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_BACKEND_VALUE|environment|extra_args|volumes/);
  assert.equal(result.executable, false);
});

test('preview refuses arbitrary operations, services and invalid replay instead of synthesizing approval', () => {
  const f = previewFixture('gateway', 'fresh');
  for (const operation of ['approve', 'shell', 'candidate', 'production-result']) assert.throws(() => previewPlan({ ...f, service: 'gateway', operation }));
  assert.throws(() => fixturePreview('unknown', 'fresh', 'test'));
  assert.throws(() => fixturePreview('gateway', 'arbitrary', 'test'));
  f.events.push({ revision: 1, kind: 'accepted', requestId: 'missing', updateId: '1'.repeat(24) });
  assert.throws(() => previewPlan({ ...f, service: 'gateway', operation: 'test' }));
});

test('HTTP preview only accepts fixed GET selections and never changes demo history or approvals', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'springbok-preview-http-'));
  const app = await startDemo({ directory, port: 0 });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = readFileSync(join(directory, 'ledger.json'), 'utf8');
  for (const scenario of SCENARIOS) {
    const response = await fetch(`${app.origin}/api/plan?service=gateway&scenario=${scenario}&operation=promote`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.scenario, scenario); assert.equal(data.executable, false);
    assert.equal(data.csrf, undefined); assert.equal(data.history.events, undefined);
  }
  for (const query of ['service=gateway&scenario=fresh&operation=approve',
    'service=gateway&scenario=fresh&operation=test&url=https://example.com',
    'service=gateway&service=forum&scenario=fresh&operation=test',
    'service=gateway&scenario=fresh']) {
    const response = await fetch(`${app.origin}/api/plan?${query}`); assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${app.origin}/api/plan?service=gateway&scenario=fresh&operation=test`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/plan?service=gateway&scenario=fresh&operation=test`, { method: 'POST' })).status, 404);
  assert.equal(readFileSync(join(directory, 'ledger.json'), 'utf8'), before);
});
