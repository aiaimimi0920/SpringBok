import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentDeclaration, automaticConfiguration, deploymentTargets } from '../cloud/deployment-contract.mjs';
import { validatePreviewInventory } from '../src/sba/preview.mjs';

const declaration = () => ({ schemaVersion: 2, target: 'cloudflare-suite', accountPath: ['accountId'], accountMode: 'single',
  accounts: [{ key: 'runtime', label: '账户', path: ['accountId'], secret: 'CLOUDFLARE_API_TOKEN' }],
  github: { repositoryPath: ['automation','repository'], secret: 'DEPLOY_GITHUB_TOKEN' }, defaults: {}, resources: [],
  fields: [{ path: ['pages'], label: 'Pages', type: 'text', required: true, template: '{instance}-pages' },
    { path: ['workflow'], label: 'Actions', type: 'text', required: true, template: '.github/workflows/refresh.yml@{instance}' }],
  targets: [{ kind: 'pages', path: ['pages'], account: 'runtime' }, { kind: 'github-actions', path: ['workflow'], account: null }] });

test('explicit suite declaration resolves Pages and canonical repository-scoped Actions identities', () => {
  const d = declaration(); assert.deepEqual(deploymentDeclaration(d), d);
  const c = automaticConfiguration(d, {}, {}, { runtime: { accountId: 'a'.repeat(32) } }, 'testing', { github: { repository: 'Owner/Repo' } });
  assert.deepEqual(deploymentTargets(d,c), [{ kind: 'pages', value: 'testing-pages', accountId: 'a'.repeat(32) },
    { kind: 'github-actions', value: '.github/workflows/refresh.yml@testing', accountId: 'github:owner/repo' }]);
});
test('legacy declarations cannot smuggle suite capabilities; secret and path aliases fail closed', () => {
  for (const mutate of [d => d.target = 'cloudflare-workers', d => d.schemaVersion = 1, d => delete d.github,
    d => d.github.secret = 'CLOUDFLARE_API_TOKEN', d => d.github.repositoryPath = ['pages'],
    d => d.targets[1].account = 'runtime', d => d.github.extra = true]) {
    const d = declaration(); mutate(d); assert.throws(() => deploymentDeclaration(d));
  }
});
test('preview inventory preserves provider identity instead of treating workflow environments as Workers', () => {
  const base = { key: 'target-actions', kind: 'github-actions', accountId: 'github:owner/repo', remoteId: '.github/workflows/refresh.yml@testing', name: 'refresh' };
  assert.deepEqual(validatePreviewInventory([base]), [base]);
  for (const patch of [{ accountId: 'a'.repeat(32) }, { accountId: 'github:Owner/Repo' }, { remoteId: '.github/workflows/../bad.yml@testing' }, { kind: 'worker' }])
    assert.throws(() => validatePreviewInventory([{ ...base, ...patch }]));
});
