import { OwnerCatalog } from '../../cloud/catalog-store.mjs';

// 仅供本地 workerd 测试破坏隔离临时库；生产 Worker 不导入或导出此类。
export class TestCatalog extends OwnerCatalog {
  damage(kind) {
    const statements = {
      version: 'UPDATE catalog_meta SET schema_version=2',
      table: 'DROP TABLE servers',
      metadata: 'DELETE FROM catalog_meta',
      column: 'ALTER TABLE servers RENAME COLUMN name TO missing_name',
    };
    if (!Object.hasOwn(statements, kind)) throw new Error('unknown test damage');
    this.ctx.storage.sql.exec(statements[kind]);
  }
  inspect() {
    return {
      tables: this.ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('catalog_meta','servers','catalog_requests') ORDER BY name").toArray(),
      metadata: this.ctx.storage.sql.exec('SELECT * FROM catalog_meta').toArray(),
      requests: this.ctx.storage.sql.exec('SELECT * FROM catalog_requests ORDER BY request_id').toArray(),
    };
  }
}
export default {
  async fetch(request, env) {
    const { operation, args } = await request.json();
    if (!['snapshot', 'mutate', 'damage', 'inspect'].includes(operation)) return new Response(null, { status: 404 });
    const catalog = env.REGISTRY.get(env.REGISTRY.idFromName(new URL(request.url).pathname));
    try { return Response.json(await catalog[operation](...args) ?? null); }
    catch { return new Response(null, { status: 409 }); }
  },
};
