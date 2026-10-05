import { NodeMailbox } from '../../cloud/node-mailbox.mjs';
import { nodeMailboxName } from '../../cloud/node-protocol.mjs';

// 仅供本地 workerd 故障注入，不是生产 HTTP 入口或节点认证适配器。
export class TestNodeMailbox extends NodeMailbox {
  inspect() { return this.ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE name IN ('node_meta','node_ledger') ORDER BY name").toArray().map(table => ({ ...table, rows: this.ctx.storage.sql.exec(`SELECT * FROM ${table.name}`).toArray() })); }
  damage(kind) {
    const sql = this.ctx.storage.sql;
    if (kind === 'version') sql.exec('UPDATE node_meta SET schema_version=99');
    else if (kind === 'owner') sql.exec("UPDATE node_meta SET owner_id=?", 'f'.repeat(64));
    else if (kind === 'table') sql.exec('DROP TABLE node_ledger');
    else if (kind === 'column') sql.exec('ALTER TABLE node_meta RENAME COLUMN node_id TO lost_node_id');
    else if (kind === 'row') sql.exec('DELETE FROM node_ledger');
    else if (kind === 'digest') {
      const state = JSON.parse(sql.exec('SELECT state FROM node_ledger').one().state);
      state.jobs[0].input.planDigest = 'sha256:' + '0'.repeat(64);
      sql.exec('UPDATE node_ledger SET state=?', JSON.stringify(state));
    } else if (kind === 'expire') {
      const state = JSON.parse(sql.exec('SELECT state FROM node_ledger').one().state);
      state.jobs[state.jobs.length - 1].expiresAt = 0;
      sql.exec('UPDATE node_ledger SET state=?', JSON.stringify(state));
    } else if (kind === 'json') sql.exec("UPDATE node_ledger SET state='broken'");
    else throw new Error('unknown damage');
    return null;
  }
}
export default { async fetch(request, env) {
  try {
    const { target, context, operation, value } = await request.json();
    if (!['snapshot', 'submitProbe', 'pollProbe', 'reportProbe', 'inspect', 'damage'].includes(operation)) throw new Error('test route denied');
    const stub = env.NODES.get(env.NODES.idFromName(nodeMailboxName(target)));
    const result = await (['inspect', 'damage'].includes(operation) ? stub[operation](value) : stub[operation](context, value));
    return Response.json(result);
  } catch { return Response.json({ error: 'test RPC rejected' }, { status: 409 }); }
} };
