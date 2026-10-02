import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareConfigurations } from '../src/config/compare.mjs';
const example = () => JSON.parse(readFileSync(new URL('../examples/config/services.json', import.meta.url)));
const pair = () => ({ baseline: example(), candidate: example() });
test('comparison binds both canonical manifests without mutation or runtime claims', () => {
  const input = pair(), before = structuredClone(input), result = compareConfigurations(input);
  assert.deepEqual(input, before); assert.equal(result.executionReady, false); assert.equal(result.executable, false);
  assert.equal(result.baselineKind, 'user-provided-config-not-runtime-evidence');
  assert.equal(result.baselineManifestDigest, result.candidateManifestDigest);
  assert.ok(result.changes.every(c => c.status === 'unchanged' && !c.differences.length));
  input.baseline.services.reverse(); input.candidate.services.reverse();
  assert.deepEqual(compareConfigurations(input), result);
  input.baseline.services[0].image = input.baseline.services[0].image.replace(/.$/, 'f');
  const changed = compareConfigurations(input); assert.notEqual(changed.reviewDigest, result.reviewDigest);
  assert.equal(changed.candidateManifestDigest, result.candidateManifestDigest);
  assert.notEqual(changed.baselineManifestDigest, result.baselineManifestDigest);
});
test('added and removed services remain explicit, with no delete or rollback operation', () => {
  const input = pair(); input.baseline.services = input.baseline.services.slice(0, 2); input.candidate.services = input.candidate.services.slice(1, 3);
  const result = compareConfigurations(input), byId = Object.fromEntries(result.changes.map(c => [c.service, c]));
  assert.equal(byId.gateway.status, 'removed'); assert.equal(byId.game.status, 'added'); assert.equal(byId.forum.status, 'unchanged');
  assert.ok(byId.gateway.requirements.includes('review-service-removal-no-delete-command-generated'));
  assert.ok(byId.gateway.differences.every(d => d.after === null)); assert.ok(byId.game.differences.every(d => d.before === null));
  assert.equal(Object.hasOwn(result, 'approval'), false); assert.equal(Object.hasOwn(result, 'operations'), false);
});
test('target, port, storage and secret-reference differences carry specific review requirements', () => {
  const input = pair(), service = input.candidate.services[1];
  service.test.deploymentName = 'forum-replacement'; service.test.serverId = 'a'.repeat(24);
  service.test.ports[0].hostIp = '0.0.0.0'; service.test.ports[0].hostPort = 20000;
  service.test.volumes[0].name = 'new-forum-data'; service.test.secretRefs[0].reference = 'new-forum-db';
  const result = compareConfigurations(input), row = result.changes.find(c => c.service === 'forum');
  assert.equal(row.status, 'modified');
  assert.deepEqual(row.differences.map(d => d.field), ['test.serverId', 'test.deploymentName', 'test.ports', 'test.volumes', 'test.secretRefs']);
  assert.deepEqual(row.requirements, ['review-target-change-not-an-in-place-update', 'review-storage-change-backup-and-migration', 'review-external-network-change', 'review-unresolved-reference-change']);
  assert.equal(result.candidate.readiness, false);
});
test('invalid manifests, extra fields, different projects and per-manifest byte excess fail closed', () => {
  const mutations = [p => { p.candidate.project = 'another'; }, p => { p.baseline.services[0].image = 'mutable:latest'; },
    p => { p.approval = true; }, p => { p.baseline.secret = 'PRIVATE'; }, p => { p.candidate.project = 'x'.repeat(65537); }];
  for (const mutate of mutations) { const p = pair(); mutate(p); assert.throws(() => compareConfigurations(p), error => !error.message.includes('PRIVATE')); }
});
