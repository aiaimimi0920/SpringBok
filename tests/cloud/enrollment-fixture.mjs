import worker, { TargetMailbox } from '../../cloud/worker.mjs';
import { OwnerCatalog as Catalog } from '../../cloud/catalog-store.mjs';
import { NodeMailbox as Mailbox } from '../../cloud/node-mailbox.mjs';
import { OwnerCatalog as LegacyCatalog } from './catalog-v2-fixture.mjs';
import { NodeMailbox as LegacyMailbox } from './node-mailbox-v1-fixture.mjs';
import { NodeMailbox as Schema2Mailbox } from './node-mailbox-v2-fixture.mjs';
import { nodeMailboxName } from '../../cloud/node-protocol.mjs';
export { TargetMailbox };

// 仅测试用故障注入；生产 Worker 不导入。故障 marker 不存任何秘密。
function failOnce(object, stage) {
  if (object.env.ENROLLMENT_FAULT !== stage) return;
  const sql = object.ctx.storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS test_enrollment_faults (stage TEXT PRIMARY KEY)');
  if (sql.exec('SELECT stage FROM test_enrollment_faults WHERE stage=?', stage).toArray().length) return;
  sql.exec('INSERT INTO test_enrollment_faults VALUES(?)', stage);
  throw new Error('injected enrollment interruption');
}
function inspect(object) {
  return object.ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('catalog_meta','servers','catalog_requests','services','server_enrollments','node_meta','node_ledger','node_enrollment','node_heartbeat') ORDER BY name").toArray().map(table => ({ ...table, rows: object.ctx.storage.sql.exec(`SELECT * FROM ${table.name}`).toArray() }));
}
export class OwnerCatalog extends Catalog {
  prepareEnrollment(owner, value) { const result = super.prepareEnrollment(owner, value); failOnce(this, 'catalog-prepare-after'); return result; }
  finalizeEnrollment(owner, value) { failOnce(this, 'catalog-finalize-before'); const result = super.finalizeEnrollment(owner, value); failOnce(this, 'catalog-finalize-after'); return result; }
  inspect() { return inspect(this); }
  legacySnapshot(owner) { return new LegacyCatalog(this.ctx, this.env).snapshot(owner); }
  fillToRevision(owner, serverId, revision) {
    let current = super.snapshot(owner).revision;
    while (current < revision) {
      const result = super.mutate(owner, { id: crypto.randomUUID(), revision: current, action: 'rename', serverId, name: '容量测试' });
      current = result.revision;
    }
    return current;
  }
  damage(kind) {
    if (kind === 'table') this.ctx.storage.sql.exec('DROP TABLE server_enrollments');
    else if (kind === 'version') this.ctx.storage.sql.exec('UPDATE catalog_meta SET schema_version=99');
    else if (kind === 'record') this.ctx.storage.sql.exec("UPDATE server_enrollments SET state='{}'");
    else if (kind === 'receipt') this.ctx.storage.sql.exec("UPDATE catalog_requests SET result_json='{}'");
    else throw new Error('unknown damage');
    return null;
  }
}
export class NodeMailbox extends Mailbox {
  async prepareEnrollment(context, value) { failOnce(this, 'node-prepare-before'); const result = await super.prepareEnrollment(context, value); failOnce(this, 'node-prepare-after'); return result; }
  async joinEnrollment(context, challenge, value) { const result = await super.joinEnrollment(context, challenge, value); failOnce(this, 'node-join-after'); return result; }
  inspect() { return inspect(this); }
  legacySnapshot(context) { return new LegacyMailbox(this.ctx, this.env).snapshot(context); }
  schema2Identity(...args) { return new Schema2Mailbox(this.ctx, this.env).credentialIdentity(...args); }
  damage(kind, role, age) {
    const sql = this.ctx.storage.sql;
    if (kind === 'table') sql.exec('DROP TABLE node_enrollment');
    else if (kind === 'version') sql.exec('UPDATE node_meta SET schema_version=99');
    else if (kind === 'record') sql.exec("UPDATE node_enrollment SET state='{}'");
    else if (kind === 'heartbeat-table') sql.exec('DROP TABLE node_heartbeat');
    else if (kind === 'heartbeat-record') sql.exec("UPDATE node_heartbeat SET state='{}'");
    else if (kind === 'heartbeat-age') {
      if (!['execute', 'observe'].includes(role) || !Number.isSafeInteger(age) || age < 0) throw new Error('invalid age');
      const state = JSON.parse(sql.exec('SELECT state FROM node_heartbeat').one().state);
      state[role].latest.receivedAt = Date.now() - age; state[role].startedAt = state[role].latest.receivedAt;
      sql.exec('UPDATE node_heartbeat SET state=?', JSON.stringify(state));
    }
    else if (kind === 'probe-expire') {
      const ledger = JSON.parse(sql.exec('SELECT state FROM node_ledger').one().state);
      for (const job of ledger.jobs) job.expiresAt = 0;
      sql.exec('UPDATE node_ledger SET state=?', JSON.stringify(ledger));
    }
    else if (kind === 'expire' || kind === 'joined-age') {
      const row = JSON.parse(sql.exec('SELECT state FROM node_enrollment').one().state);
      row.createdAt = Date.now() - 600001; row.expiresAt = row.createdAt + 600000;
      if (kind === 'joined-age') { if (row.status !== 'joined') throw new Error('not joined'); row.joinedAt = row.createdAt + 1; }
      sql.exec('UPDATE node_enrollment SET state=?', JSON.stringify(row));
    } else throw new Error('unknown damage');
    return null;
  }
}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname !== '/__enrollment_fixture') return worker.fetch(request, env);
  try {
    const { resource, context, operation, args = [] } = await request.json();
    if (!['inspect', 'legacySnapshot', 'snapshot', 'submitProbe', 'pollProbe', 'damage', 'fillToRevision', 'credentialIdentity', 'credentialProbe', 'adminProbe', 'schema2Identity'].includes(operation)) throw new Error('unknown test method');
    const namespace = resource === 'catalog' ? env.REGISTRY : env.NODES;
    const name = resource === 'catalog' ? `catalog/v1/${context.ownerId}` : nodeMailboxName(context);
    return Response.json(await namespace.get(namespace.idFromName(name))[operation](...args));
  } catch { return new Response(null, { status: 409 }); }
} };
