import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLab, validateManifest, SERVICES } from '../src/contract.mjs';
const fixture = () => JSON.parse(readFileSync(new URL('../examples/services.json', import.meta.url)));
const digest = (c) => `sha256:${c.repeat(64)}`;
const human = { id: 'owner', role: 'human' };
const ai = { id: 'assistant', role: 'ai' };
const runner = { id: 'fixture-runner', role: 'runner' };
function harness(service = 'gateway') {
  const lab = createLab(fixture());
  const call = (operation, params = {}, actor = ai) => lab.dispatch({ service, operation, params }, actor);
  const tested = () => { call('test'); call('test-result', { success: true }, runner); };
  const approve = () => call('approve', { binding: lab.approvalBinding(service) }, human);
  const live = () => { tested(); approve(); call('promote'); call('production-result', { success: true }, runner); };
  return { lab, call, tested, approve, live };
}
test('canonical manifest supports exactly four independent service targets', () => {
  const input = fixture();
  assert.deepEqual(validateManifest(input), validateManifest({ ...input, services: input.services.reverse() }));
  for (const mutate of [
    m => m.services.pop(), m => m.services[1].id = 'gateway',
    m => m.services[0].artifact = 'image:latest', m => m.services[0].configDigest = 'sha256:bad',
    m => m.services[0].productionTarget = m.services[0].testTarget,
    m => m.services[0].testTarget = 'https://example.com', m => m.command = 'sh',
    m => m.services[0].secrets = {}, m => m.version = 2,
  ]) {
    const value = fixture(); mutate(value); assert.throws(() => validateManifest(value));
  }
});
for (const service of SERVICES) test(`${service}: test, acceptance, production and known-good rollback`, () => {
  const { lab, call, live } = harness(service);
  live();
  const first = lab.snapshot().services.find(s => s.spec.id === service).active;
  call('candidate', { artifact: digest('b'), configDigest: digest('c') }, human);
  live();
  const rolling = call('rollback');
  assert.deepEqual(rolling.pendingRollback, first);
  assert.equal(rolling.phase, 'rolling-back');
  assert.equal(call('rollback-result', { success: true }, runner).phase, 'rolled-back');
  const final = lab.snapshot();
  assert.deepEqual(final.services.find(s => s.spec.id === service).active, first);
  assert.ok(final.services.filter(s => s.spec.id !== service).every(s => s.phase === 'ready'));
  assert.deepEqual(final.events.map(e => e.sequence), final.events.map((_, i) => i + 1));
});
test('AI cannot approve, impersonate runner in params, change candidate or submit commands', () => {
  const { lab, call, tested } = harness(); tested();
  const before = lab.snapshot();
  for (const [op, params] of [
    ['approve', { binding: lab.approvalBinding('gateway') }],
    ['candidate', { artifact: digest('b'), configDigest: digest('c') }],
    ['test-result', { success: true }], ['execute', { command: 'sh' }],
    ['test', { actor: human }], ['test', { url: 'http://example.com' }],
  ]) assert.throws(() => call(op, params));
  assert.deepEqual(lab.snapshot(), before);
});
test('skip gates, stale acceptance and wrong service binding fail closed', () => {
  const { lab, call, tested, approve } = harness();
  assert.throws(() => call('promote'));
  assert.throws(() => call('approve', { binding: lab.approvalBinding('gateway') }, human));
  tested();
  assert.throws(() => call('approve', { binding: lab.approvalBinding('forum') }, human));
  const stale = lab.approvalBinding('gateway'); approve();
  call('candidate', { artifact: digest('b'), configDigest: digest('c') }, human);
  assert.throws(() => call('promote'));
  tested(); assert.throws(() => call('approve', { binding: stale }, human));
  approve(); call('test');
  assert.throws(() => call('promote'));
});
test('approval binding covers service, both targets, artifact and configuration', () => {
  const initial = fixture();
  const old = createLab(initial).approvalBinding('gateway');
  for (const [field, value] of [['testTarget', 'other-test'], ['productionTarget', 'other-prod'], ['artifact', digest('b')], ['configDigest', digest('c')]]) {
    const next = fixture(); next.services[0][field] = value;
    assert.notEqual(createLab(next).approvalBinding('gateway'), old);
  }
});
test('failed test never becomes acceptance-ready and malformed evidence does not mutate', () => {
  const { lab, call } = harness(); call('test');
  const before = lab.snapshot();
  assert.throws(() => call('test-result', { success: 'true' }, runner));
  assert.deepEqual(lab.snapshot(), before);
  assert.equal(call('test-result', { success: false }, runner).phase, 'test-failed');
  assert.throws(() => call('approve', { binding: lab.approvalBinding('gateway') }, human));
  assert.equal(call('test').phase, 'testing');
});
test('failed promotion retains known good and failed rollback remains failed until retry evidence', () => {
  const { lab, call, live, tested, approve } = harness(); live();
  const first = lab.snapshot().services.find(s => s.spec.id === 'gateway').active;
  call('candidate', { artifact: digest('b'), configDigest: digest('c') }, human);
  tested(); approve(); call('promote');
  const failed = call('production-result', { success: false }, runner);
  assert.equal(failed.phase, 'production-failed'); assert.deepEqual(failed.active, first);
  assert.throws(() => call('production-result', { success: true }, runner));
  assert.throws(() => call('candidate', { artifact: digest('c'), configDigest: digest('c') }, human));
  assert.deepEqual(call('rollback').pendingRollback, first);
  assert.equal(call('rollback-result', { success: false }, runner).phase, 'rollback-failed');
  assert.throws(() => call('promote'));
  assert.deepEqual(call('rollback').pendingRollback, first);
  assert.deepEqual(call('rollback-result', { success: true }, runner).active, first);
});
test('no arbitrary rollback target; first release has none; repeated actions rejected', () => {
  const { call, live } = harness(); live();
  assert.throws(() => call('rollback'));
  assert.throws(() => call('rollback', { artifact: digest('b') }));
  assert.throws(() => call('promote'));
  assert.throws(() => call('production-result', { success: true }, runner));
});
test('input and snapshots cannot mutate internal approvals or active releases', () => {
  const input = fixture(); const lab = createLab(input);
  input.services[0].artifact = digest('f');
  const first = lab.snapshot(); first.services[0].phase = 'approved'; first.events.push({});
  assert.notEqual(lab.snapshot().services[0].phase, 'approved');
  assert.equal(lab.snapshot().events.length, 0);
  assert.equal(lab.snapshot().services.find(s => s.spec.id === 'gateway').spec.artifact, digest('1'));
});
test('all workflows remain pinned and read-only without credentials or production publish', () => {
  const workflow = readFileSync(new URL('../.github/workflows/contract-tests.yml', import.meta.url), 'utf8');
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|contents: write|packages: write/);
  for (const [, ref] of workflow.matchAll(/uses:\s+([^\s]+)/g)) assert.match(ref, /@[a-f0-9]{40}$/);
  const shell = readFileSync(new URL('../scripts/ci/container-smoke.sh', import.meta.url), 'utf8');
  assert.match(shell, /--network=none/); assert.doesNotMatch(shell, /docker push|--privileged|--publish|--volume/);
});
