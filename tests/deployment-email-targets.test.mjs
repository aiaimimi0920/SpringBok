import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentDeclaration, deploymentTargets } from '../cloud/deployment-contract.mjs';
import { deploymentIdentities } from '../cloud/deployment-ownership.mjs';
import { validateRequest } from '../src/sba/contract.mjs';
import { previewManifest, previewRequest } from './sba-preview-fixture.mjs';

const accountId = 'a'.repeat(32), zoneId = 'e'.repeat(32);
const declaration = () => ({ schemaVersion: 2, target: 'cloudflare-workers', accountMode: 'single', accountPath: ['accountId'],
  accounts: [{ key: 'runtime', label: 'Account', path: ['accountId'], secret: 'CLOUDFLARE_API_TOKEN' }], defaults: { routing: null }, resources: [],
  fields: [{ path: ['worker'], type: 'text', label: 'Worker', required: true, template: '{instance}-worker' },
    { path: ['routing'], type: 'json', label: 'Routing', required: false, template: null }],
  targets: [{ kind: 'worker', path: ['worker'], account: 'runtime' }, { kind: 'email-routing', path: ['routing'], account: 'runtime', workerPath: ['worker'] }],
});
test('email declaration enforces v2, nullable JSON defaults and same-account declared Worker ownership', () => {
  deploymentDeclaration(declaration());
  for (const mutate of [d => { d.schemaVersion = 1; }, d => { delete d.defaults.routing; }, d => { d.defaults.routing = {}; },
    d => { d.fields[1].required = true; }, d => { d.fields[1].type = 'text'; }, d => { d.fields[1].template = '{instance}'; },
    d => { d.targets[1].workerPath = ['missing']; }, d => { d.targets[1].workerPath = ['__proto__']; },
    d => { d.targets[0].kind = 'domain'; }, d => { d.targets[1].extra = true; },
    d => { d.accountMode = 'multiple'; d.accounts.push({ key: 'other', label: 'Other', path: ['otherAccount'], secret: 'OTHER_TOKEN' }); d.targets[1].account = 'other'; },
  ]) { const d = declaration(); mutate(d); assert.throws(() => deploymentDeclaration(d)); }
});
test('resolved email identity is zone-exclusive, null acquires no email identity, and duplicate or forged values are rejected', () => {
  const d = declaration(), configuration = { accountId, worker: 'test-worker', routing: { zoneId, domain: 'example.invalid' } };
  const target = deploymentTargets(d, configuration).at(-1);
  assert.deepEqual(target, { kind: 'email-routing', value: 'email-routing:' + zoneId, accountId, zoneId, domain: 'example.invalid', worker: 'test-worker' });
  const plan = { application: { declaration: d }, configuration, resources: {} };
  assert.ok(deploymentIdentities(plan).includes('email-routing:' + zoneId));
  assert.equal(deploymentTargets(d, { ...configuration, worker: 'other-worker' }).at(-1).value, target.value);
  assert.deepEqual(deploymentTargets(d, { ...configuration, routing: null }).map(row => row.kind), ['worker']);
  for (const routing of [undefined, {}, { zoneId, domain: 'EXAMPLE.invalid' }, { zoneId, domain: 'https://example.invalid' }, { zoneId, domain: 'example.invalid', extra: true }]) assert.throws(() => deploymentTargets(d, { ...configuration, routing }));
  d.defaults.secondary = null; d.fields.push({ ...d.fields[1], path: ['secondary'] }); d.targets.push({ ...d.targets[1], path: ['secondary'] });
  deploymentDeclaration(d); assert.throws(() => deploymentTargets(d, { ...configuration, secondary: configuration.routing }));
});
test('executor preview accepts a read-only source email identity but rejects it in writable and cleanup inventories', () => {
  const manifest = previewManifest(), r = previewRequest();
  const row = { key: 'source-email', kind: 'email-routing', accountId, remoteId: 'email-routing:' + zoneId, name: 'example.invalid' };
  r.context.source.resources.push(row); validateRequest(r, manifest);
  for (const patch of [{ remoteId: zoneId }, { remoteId: 'email-routing:invalid' }, { accountId: 'github:owner/repo' }]) {
    const invalid = structuredClone(r); Object.assign(invalid.context.source.resources.at(-1), patch); assert.throws(() => validateRequest(invalid, manifest));
  }
  const invalid = structuredClone(r); invalid.context.resources.push(row); assert.throws(() => validateRequest(invalid, manifest));
  const remove = { ...r, action: 'destroy-preview', previous: { sourceSha: r.sourceSha, applicationVersion: r.applicationVersion },
    context: { instanceId: r.taskId, previewTaskId: r.taskId, resultDigest: 'f'.repeat(64), resources: [...r.context.resources, row] } };
  assert.throws(() => validateRequest(remove, manifest));
});
