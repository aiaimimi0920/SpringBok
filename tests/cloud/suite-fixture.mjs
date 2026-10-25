import { previewFixture } from './preview-fixture.mjs';

export async function suiteFixture(overrides = {}) {
  const fixture = await previewFixture(overrides), { state } = fixture;
  Object.assign(state.declaration, { target: 'cloudflare-suite', github: { repositoryPath: ['automation','repository'], secret: 'DEPLOY_GITHUB_TOKEN' } });
  state.declaration.fields.push(
    { path: ['pages','name'], label: 'Pages', type: 'text', required: true, template: '{instance}-pages' },
    { path: ['automation','workflow'], label: 'Actions', type: 'text', required: true, template: '.github/workflows/refresh.yml@{instance}' });
  state.declaration.targets.push({ kind: 'pages', path: ['pages','name'], account: 'runtime' },
    { kind: 'github-actions', path: ['automation','workflow'], account: null });
  state.manifestOverride.secrets = ['CLOUDFLARE_API_TOKEN', 'DEPLOY_GITHUB_TOKEN'];
  return fixture;
}
