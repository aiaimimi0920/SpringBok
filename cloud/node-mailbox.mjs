import { DurableObject } from 'cloudflare:workers';
import { nodeContext, nodeMailboxName, nodeLedger, probePlan, nodeTransition, verifyNodePlans } from './node-protocol.mjs';

// N01-S01 仅提供可信服务端内部 RPC。公开节点鉴权/角色/生命周期由 N02/N03 接入。
export class NodeMailbox extends DurableObject {
  #context(value) {
    const context = nodeContext(value);
    if (this.env.ENABLE_NODE_MAILBOX !== 'yes' || !this.env.NODES || this.ctx.id.toString() !== this.env.NODES.idFromName(nodeMailboxName(context)).toString()) throw new Error('node mailbox disabled or mismatched');
    return context;
  }
  #read(context) {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('node_meta','node_ledger')").toArray();
    if (!tables.length) {
      sql.exec('CREATE TABLE node_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, owner_id TEXT NOT NULL, node_id TEXT NOT NULL)');
      sql.exec('CREATE TABLE node_ledger (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
      sql.exec('INSERT INTO node_meta VALUES(1,1,?,?)', context.ownerId, context.nodeId);
      sql.exec('INSERT INTO node_ledger VALUES(1,?)', JSON.stringify({ revision: 0, jobs: [] }));
    } else if (tables.length !== 2) throw new Error('incomplete node storage');
    const meta = sql.exec('SELECT * FROM node_meta').toArray(), rows = sql.exec('SELECT * FROM node_ledger').toArray();
    if (meta.length !== 1 || meta[0].id !== 1 || meta[0].schema_version !== 1 || meta[0].owner_id !== context.ownerId || meta[0].node_id !== context.nodeId || rows.length !== 1 || rows[0].id !== 1) throw new Error('invalid node storage');
    return nodeLedger(JSON.parse(rows[0].state), context);
  }
  async #run(value, operation, input = null) {
    const context = this.#context(value);
    // 等待摘要校验时阻止其他 RPC 交错；最终写入和 claimed 同事务提交后才交付。
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = this.ctx.storage.transactionSync(() => this.#read(context));
      await verifyNodePlans(state, context);
      if (operation === 'snapshot') return { mode: 'internal-node-probe-only', executionReady: false, protocolVersion: 2, ...context, ...state };
      const result = nodeTransition(state, context, operation, input, Date.now());
      if (result.changed) this.ctx.storage.transactionSync(() => {
        this.#context(context);
        this.ctx.storage.sql.exec('UPDATE node_ledger SET state=? WHERE id=1', JSON.stringify(result.state));
      });
      return result.response;
    });
  }
  snapshot(context) { return this.#run(context, 'snapshot'); }
  async submitProbe(value, request) {
    const context = this.#context(value);
    return this.#run(context, 'submitProbe', await probePlan(context, request));
  }
  pollProbe(context, request) { return this.#run(context, 'pollProbe', request); }
  reportProbe(context, receipt) { return this.#run(context, 'reportProbe', receipt); }
}
