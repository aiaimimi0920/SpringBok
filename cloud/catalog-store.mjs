import { DurableObject } from 'cloudflare:workers';
import { catalogInput, serviceInput, catalogReceipt, catalogName, requireCatalog, isUuid, MAX_SERVERS, MAX_SERVICES, MAX_CATALOG_REQUESTS } from './catalog-contract.mjs';

export class OwnerCatalog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.enabled = env.ENABLE_ADMIN === 'yes' && env.ENABLE_CATALOG === 'yes';
  }
  #metadata(owner) {
    requireCatalog(this.enabled && typeof owner === 'string' && /^[a-f0-9]{64}$/.test(owner));
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('catalog_meta','servers','catalog_requests','services')").toArray();
    if (!tables.length) {
      // 首次初始化和 owner 绑定一起提交；已有目录缺表时拒绝，不能重建为空库。
      sql.exec('CREATE TABLE catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL)');
      sql.exec("CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','archived')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
      sql.exec('CREATE TABLE catalog_requests (request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL)');
      sql.exec('INSERT INTO catalog_meta VALUES(1,1,?,0)', owner);
    }
    const metadata = sql.exec('SELECT * FROM catalog_meta').toArray(), row = metadata[0];
    requireCatalog(metadata.length === 1 && row.id === 1 && [1, 2].includes(row.schema_version) && row.owner === owner && Number.isSafeInteger(row.revision) && row.revision >= 0);
    const expected = row.schema_version === 1 ? ['catalog_meta', 'servers', 'catalog_requests'] : ['catalog_meta', 'servers', 'catalog_requests', 'services'];
    const present = tables.length ? tables.map(table => table.name) : ['catalog_meta', 'servers', 'catalog_requests'];
    requireCatalog(present.length === expected.length && expected.every(name => present.includes(name)));
    requireCatalog(sql.exec('SELECT count(*) AS n FROM catalog_requests').one().n === row.revision && row.revision <= MAX_CATALOG_REQUESTS);
    // 只扩展已完整验证的 v1；损坏旧库不能通过迁移变成空目录。外层事务同时提交 schema 和数据。
    this.#rows(); sql.exec('SELECT request_id,input_json,result_json FROM catalog_requests LIMIT 0').toArray();
    if (row.schema_version === 1) {
      const receipts = sql.exec('SELECT request_id,input_json,result_json FROM catalog_requests').toArray();
      const revisions = new Set(receipts.map(entry => catalogReceipt(entry, row.revision, false).revision));
      requireCatalog(revisions.size === row.revision);
      sql.exec("CREATE TABLE services (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id), name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','archived')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
      sql.exec('UPDATE catalog_meta SET schema_version=2 WHERE id=1');
    }
    return row;
  }
  #rows() {
    const rows = this.ctx.storage.sql.exec('SELECT id,name,state,created_at AS createdAt,updated_at AS updatedAt FROM servers ORDER BY created_at,id').toArray();
    requireCatalog(rows.length <= MAX_SERVERS);
    for (const row of rows) requireCatalog(isUuid(row.id) && catalogName(row.name) === row.name && ['draft', 'archived'].includes(row.state) && Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.updatedAt) && row.createdAt >= 0 && row.updatedAt >= row.createdAt);
    return rows;
  }
  #services(servers) {
    const rows = this.ctx.storage.sql.exec('SELECT id,server_id AS serverId,name,state,created_at AS createdAt,updated_at AS updatedAt FROM services ORDER BY created_at,id').toArray();
    requireCatalog(rows.length <= MAX_SERVICES);
    for (const row of rows) {
      const server = servers.find(item => item.id === row.serverId);
      requireCatalog(isUuid(row.id) && catalogName(row.name) === row.name && ['draft', 'archived'].includes(row.state) && Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.updatedAt) && row.createdAt >= 0 && row.updatedAt >= row.createdAt && server && (row.state === 'archived' || server.state === 'draft'));
    }
    return rows;
  }
  snapshot(owner) {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#metadata(owner);
      const servers = this.#rows(); this.#services(servers);
      return { mode: 'server-catalog-only', executionReady: false, revision: meta.revision, servers };
    });
  }
  serviceSnapshot(owner) {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#metadata(owner);
      return { mode: 'service-catalog-only', executionReady: false, revision: meta.revision, services: this.#services(this.#rows()) };
    });
  }
  mutate(owner, value) { return this.#mutate(owner, catalogInput(value), 'server'); }
  mutateService(owner, value) { return this.#mutate(owner, serviceInput(value), 'service'); }
  #mutate(owner, input, resource) {
    // 保持 v1 服务器回执的规范输入不变；服务加内部域标识，防止同一请求 ID 跨资源重放。
    const serialized = JSON.stringify(resource === 'server' ? input : { resource: 'service', ...input });
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#metadata(owner), sql = this.ctx.storage.sql, servers = this.#rows(), services = this.#services(servers);
      const prior = sql.exec('SELECT request_id,input_json,result_json FROM catalog_requests WHERE request_id=?', input.id).toArray()[0];
      if (prior) { requireCatalog(prior.input_json === serialized); return catalogReceipt(prior, meta.revision); }
      requireCatalog(input.revision === meta.revision && meta.revision < MAX_CATALOG_REQUESTS);
      const rows = resource === 'server' ? servers : services, table = resource === 'server' ? 'servers' : 'services';
      const now = Date.now(); let record;
      if (input.action === 'create') {
        requireCatalog(rows.length < (resource === 'server' ? MAX_SERVERS : MAX_SERVICES));
        if (resource === 'service') requireCatalog(servers.find(server => server.id === input.serverId)?.state === 'draft');
        record = { id: crypto.randomUUID(), ...(resource === 'service' ? { serverId: input.serverId } : {}), name: input.name, state: 'draft', createdAt: now, updatedAt: now };
        if (resource === 'server') sql.exec('INSERT INTO servers VALUES(?,?,?,?,?)', record.id, record.name, record.state, now, now);
        else sql.exec('INSERT INTO services VALUES(?,?,?,?,?,?)', record.id, record.serverId, record.name, record.state, now, now);
      } else {
        const previous = rows.find(row => row.id === (resource === 'server' ? input.serverId : input.serviceId));
        requireCatalog(previous?.state === 'draft');
        if (resource === 'server' && input.action === 'archive') requireCatalog(!services.some(service => service.serverId === previous.id && service.state === 'draft'));
        record = { ...previous, ...(input.action === 'rename' ? { name: input.name } : { state: 'archived' }), updatedAt: Math.max(now, previous.updatedAt) };
        sql.exec(`UPDATE ${table} SET name=?,state=?,updated_at=? WHERE id=?`, record.name, record.state, record.updatedAt, record.id);
      }
      const result = { id: input.id, revision: meta.revision + 1, [resource]: record };
      sql.exec('UPDATE catalog_meta SET revision=? WHERE id=1', result.revision);
      sql.exec('INSERT INTO catalog_requests VALUES(?,?,?)', input.id, serialized, JSON.stringify(result));
      return result;
    });
  }
}
