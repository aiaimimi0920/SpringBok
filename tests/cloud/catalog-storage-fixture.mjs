import { OwnerCatalog } from '../../cloud/catalog-store.mjs';
import { OwnerCatalog as LegacyCatalog } from './catalog-v1-fixture.mjs';

// 仅供本地 workerd 测试破坏隔离临时库；生产 Worker 不导入或导出此类。
export class TestCatalog extends OwnerCatalog {
  legacy(owner, input) { return new LegacyCatalog(this.ctx, { ENABLE_ADMIN: 'yes', ENABLE_CATALOG: 'yes' }).mutate(owner, input); }
  legacySnapshot(owner) { return new LegacyCatalog(this.ctx, { ENABLE_ADMIN: 'yes', ENABLE_CATALOG: 'yes' }).snapshot(owner); }
  damage(kind) {
    if (kind === 'serviceReference') {
      // 正常 SQL 的外键会拒绝孤立引用；仅测试中重建无外键的损坏表，验证读写仍失败关闭。
      return this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql, rows = sql.exec('SELECT * FROM services').toArray();
        sql.exec('DROP TABLE services');
        sql.exec('CREATE TABLE services (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
        for (const row of rows) sql.exec('INSERT INTO services VALUES(?,?,?,?,?,?)', row.id, row.server_id, row.name, row.state, row.created_at, row.updated_at);
        sql.exec("UPDATE services SET server_id='00000000-0000-4000-8000-000000000000'");
      });
    }
    const statements = {
      version: 'UPDATE catalog_meta SET schema_version=3',
      table: 'DROP TABLE servers',
      metadata: 'DELETE FROM catalog_meta',
      column: 'ALTER TABLE servers RENAME COLUMN name TO missing_name',
      serviceTable: 'DROP TABLE services',
      serviceColumn: 'ALTER TABLE services RENAME COLUMN server_id TO missing_server_id',
      v1Row: "UPDATE servers SET name=''",
      v1Requests: 'ALTER TABLE catalog_requests RENAME COLUMN result_json TO missing_result',
      receiptJson: "UPDATE catalog_requests SET result_json='not-json'",
      receiptShape: "UPDATE catalog_requests SET result_json='{}'",
      receiptRevision: "UPDATE catalog_requests SET result_json=json_set(result_json,'$.revision',999)",
      serviceName: "UPDATE services SET name=''",
      serviceTime: 'UPDATE services SET updated_at=-1',
      linkedArchive: "UPDATE servers SET state='archived'",
    };
    if (!Object.hasOwn(statements, kind)) throw new Error('unknown test damage');
    this.ctx.storage.sql.exec(statements[kind]);
  }
  inspect() {
    return {
      tables: this.ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('catalog_meta','servers','catalog_requests','services') ORDER BY name").toArray(),
      metadata: this.ctx.storage.sql.exec('SELECT * FROM catalog_meta').toArray(),
      requests: this.ctx.storage.sql.exec('SELECT * FROM catalog_requests ORDER BY request_id').toArray(),
      servers: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='servers'").toArray().length ? this.ctx.storage.sql.exec('SELECT * FROM servers ORDER BY id').toArray() : [],
      services: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='services'").toArray().length ? this.ctx.storage.sql.exec('SELECT * FROM services ORDER BY id').toArray() : [],
    };
  }
}
export default {
  async fetch(request, env) {
    const { operation, args } = await request.json();
    if (!['snapshot', 'mutate', 'serviceSnapshot', 'mutateService', 'legacy', 'legacySnapshot', 'damage', 'inspect'].includes(operation)) return new Response(null, { status: 404 });
    const catalog = env.REGISTRY.get(env.REGISTRY.idFromName(new URL(request.url).pathname));
    try { return Response.json(await catalog[operation](...args) ?? null); }
    catch { return new Response(null, { status: 409 }); }
  },
};
