import { DurableObject } from 'cloudflare:workers';
import { catalogInput, catalogName, requireCatalog, isUuid, MAX_SERVERS, MAX_CATALOG_REQUESTS } from './catalog-contract.mjs';

export class OwnerCatalog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.enabled = env.ENABLE_ADMIN === 'yes' && env.ENABLE_CATALOG === 'yes';
  }
  #metadata(owner) {
    requireCatalog(this.enabled && typeof owner === 'string' && /^[a-f0-9]{64}$/.test(owner));
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('catalog_meta','servers','catalog_requests')").toArray();
    if (!tables.length) {
      // 首次初始化和 owner 绑定一起提交；已有目录缺表时拒绝，不能重建为空库。
      sql.exec('CREATE TABLE catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL)');
      sql.exec("CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','archived')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
      sql.exec('CREATE TABLE catalog_requests (request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL)');
      sql.exec('INSERT INTO catalog_meta VALUES(1,1,?,0)', owner);
    } else requireCatalog(tables.length === 3);
    const metadata = sql.exec('SELECT * FROM catalog_meta').toArray(), row = metadata[0];
    requireCatalog(metadata.length === 1 && row.id === 1 && row.schema_version === 1 && row.owner === owner && Number.isSafeInteger(row.revision) && row.revision >= 0);
    requireCatalog(sql.exec('SELECT count(*) AS n FROM catalog_requests').one().n === row.revision && row.revision <= MAX_CATALOG_REQUESTS);
    return row;
  }
  #rows() {
    const rows = this.ctx.storage.sql.exec('SELECT id,name,state,created_at AS createdAt,updated_at AS updatedAt FROM servers ORDER BY created_at,id').toArray();
    requireCatalog(rows.length <= MAX_SERVERS);
    for (const row of rows) requireCatalog(isUuid(row.id) && catalogName(row.name) === row.name && ['draft', 'archived'].includes(row.state) && Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.updatedAt) && row.createdAt >= 0 && row.updatedAt >= row.createdAt);
    return rows;
  }
  snapshot(owner) {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#metadata(owner);
      return { mode: 'server-catalog-only', executionReady: false, revision: meta.revision, servers: this.#rows() };
    });
  }
  mutate(owner, value) {
    const input = catalogInput(value), serialized = JSON.stringify(input);
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#metadata(owner), sql = this.ctx.storage.sql, rows = this.#rows();
      const prior = sql.exec('SELECT input_json,result_json FROM catalog_requests WHERE request_id=?', input.id).toArray()[0];
      if (prior) { requireCatalog(prior.input_json === serialized); return JSON.parse(prior.result_json); }
      requireCatalog(input.revision === meta.revision && meta.revision < MAX_CATALOG_REQUESTS);
      const now = Date.now(); let server;
      if (input.action === 'create') {
        requireCatalog(rows.length < MAX_SERVERS);
        server = { id: crypto.randomUUID(), name: input.name, state: 'draft', createdAt: now, updatedAt: now };
        sql.exec('INSERT INTO servers VALUES(?,?,?,?,?)', server.id, server.name, server.state, now, now);
      } else {
        const previous = rows.find(row => row.id === input.serverId);
        requireCatalog(previous?.state === 'draft');
        server = { ...previous, ...(input.action === 'rename' ? { name: input.name } : { state: 'archived' }), updatedAt: Math.max(now, previous.updatedAt) };
        sql.exec('UPDATE servers SET name=?,state=?,updated_at=? WHERE id=?', server.name, server.state, server.updatedAt, server.id);
      }
      const result = { id: input.id, revision: meta.revision + 1, server };
      sql.exec('UPDATE catalog_meta SET revision=? WHERE id=1', result.revision);
      sql.exec('INSERT INTO catalog_requests VALUES(?,?,?)', input.id, serialized, JSON.stringify(result));
      return result;
    });
  }
}
