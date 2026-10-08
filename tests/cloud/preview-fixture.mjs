import { createHash } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';

export function configurePreviewFixture(fixture) {
  const { state, input, receipt } = fixture, previous = state.provider, base = structuredClone(state.declaration);
  state.declaration = { ...base, schemaVersion: 2, accountMode: 'single', accounts: [{ key: 'runtime', label: '账户', path: ['accountId'], secret: 'CLOUDFLARE_API_TOKEN' }],
    fields: [...base.fields.map(field => ({ ...field, template: field.type === 'text' ? '{instance}-worker' : null })), { path: ['url'], label: '地址', type: 'text', required: true, template: 'https://{instance}-worker.{subdomain:runtime}.workers.dev' }],
    resources: base.resources.map(row => ({ ...row, account: 'runtime', nativeAccount: 'runtime', nameTemplate: '{instance}-db' })),
    targets: [...base.targets.map(target => ({ ...target, account: 'runtime' })), { kind: 'domain', path: ['url'], account: 'runtime' }] };
  state.manifestOverride = { schemaVersion: 3, actions: { deploy: { timeoutSeconds: 60 }, update: { timeoutSeconds: 60 }, verify: { timeoutSeconds: 60 }, preview: { timeoutSeconds: 60 }, 'destroy-preview': { timeoutSeconds: 60 } } };
  input.values = {}; input.resources = {}; state.resources = null; state.created = []; state.reuseSourceId = false;
  state.provider = async (request, context) => {
    const url = new URL(request.url);
    if (url.origin === 'https://api.cloudflare.com') {
      if (url.pathname.endsWith('/workers/subdomain')) return Response.json({ success: true, result: { subdomain: 'synthetic-test' } });
      if (request.method === 'POST' && url.pathname.endsWith('/d1/database')) {
        const body = await request.json(), id = createHash('sha256').update(body.name).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
        state.created.push({ id, name: body.name });
        return Response.json({ success: true, result: { uuid: state.reuseSourceId ? state.created[0].id : id, name: body.name } });
      }
    }
    return previous(request, context);
  };
  const complete = (permit, status = 'succeeded', patch = {}) => {
    const r = state.request;
    const ids = r.action === 'preview' ? ['snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated'] : r.action === 'update' ? ['backup-created', 'data-preserved'] : ['synthetic-check'];
    const lifecycle = r.context ? { resources: r.context.resources.map(row => ({ key: row.key, status: r.action === 'preview' ? 'created' : 'removed' })),
      ...(r.action === 'preview' ? { urls: r.context.urls, snapshot: { id: 'e'.repeat(64), createdAt: Date.now() } } : {}) } : null;
    receipt(permit, status, { checks: ids.map(id => ({ id, passed: status === 'succeeded' })), ...(lifecycle ? { lifecycle } : {}), ...patch });
  };
  return { ...fixture, complete };
}
export async function previewFixture() { return configurePreviewFixture(await serviceFixture()); }
