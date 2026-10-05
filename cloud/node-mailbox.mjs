import { DurableObject } from 'cloudflare:workers';
import { nodeContext, nodeMailboxName, nodeLedger, probePlan, nodeTransition, verifyNodePlans } from './node-protocol.mjs';
import { preparedEnrollment, nodeEnrollment, joinInput, joinChallengeDigest, requireEnrollment } from './enrollment-contract.mjs';
import { nodeRole, credentialDigest, identityResult, requireCredential } from './credential-contract.mjs';

// N01-S01 仅提供可信服务端内部 RPC。公开节点鉴权/角色/生命周期由 N02/N03 接入。
export class NodeMailbox extends DurableObject {
  #context(value) {
    const context = nodeContext(value);
    if (this.env.ENABLE_NODE_MAILBOX !== 'yes' || !this.env.NODES || this.ctx.id.toString() !== this.env.NODES.idFromName(nodeMailboxName(context)).toString()) throw new Error('node mailbox disabled or mismatched');
    return context;
  }
  #record() {
    const rows = this.ctx.storage.sql.exec('SELECT id,state FROM node_enrollment').toArray();
    requireEnrollment(rows.length <= 1 && (!rows.length || rows[0].id === 1));
    return rows.length ? nodeEnrollment(JSON.parse(rows[0].state)) : null;
  }
  #read(context, initialize = true) {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('node_meta','node_ledger','node_enrollment')").toArray();
    if (!tables.length) {
      if (!initialize) return null;
      sql.exec('CREATE TABLE node_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, owner_id TEXT NOT NULL, node_id TEXT NOT NULL)');
      sql.exec('CREATE TABLE node_ledger (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
      sql.exec('INSERT INTO node_meta VALUES(1,1,?,?)', context.ownerId, context.nodeId);
      sql.exec('INSERT INTO node_ledger VALUES(1,?)', JSON.stringify({ revision: 0, jobs: [] }));
    } else if (!tables.some(row => row.name === 'node_meta') || !tables.some(row => row.name === 'node_ledger')) throw new Error('incomplete node storage');
    const meta = sql.exec('SELECT * FROM node_meta').toArray(), rows = sql.exec('SELECT * FROM node_ledger').toArray();
    if (meta.length !== 1 || meta[0].id !== 1 || ![1, 2].includes(meta[0].schema_version) || meta[0].owner_id !== context.ownerId || meta[0].node_id !== context.nodeId || rows.length !== 1 || rows[0].id !== 1) throw new Error('invalid node storage');
    if (tables.length && tables.length !== (meta[0].schema_version === 2 ? 3 : 2)) throw new Error('incomplete node storage');
    if (meta[0].schema_version === 2) this.#record();
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
  #summary(context, record) {
    return { protocolVersion: 2, ...context, executionReady: false,
      status: !record ? 'unprepared' : record.status === 'joined' ? 'joined' : Date.now() >= record.expiresAt ? 'expired' : 'pending',
      ...(record ? { enrollmentId: record.enrollmentId, expiresAt: record.expiresAt } : {}),
      ...(record?.status === 'joined' ? { requestId: record.input.requestId, joinedAt: record.joinedAt } : {}) };
  }
  async #enrollmentRun(value, initialize, perform, feature = 'ENABLE_NODE_ENROLLMENT') {
    const context = this.#context(value);
    requireEnrollment(this.env[feature] === 'yes');
    return this.ctx.blockConcurrencyWhile(async () => {
      const ledger = this.ctx.storage.transactionSync(() => this.#read(context, initialize));
      if (ledger === null) return perform(null, null, context);
      await verifyNodePlans(ledger, context);
      return this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql, meta = sql.exec('SELECT schema_version FROM node_meta').one();
        if (meta.schema_version === 1 && initialize) {
          sql.exec('CREATE TABLE node_enrollment (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
          sql.exec('UPDATE node_meta SET schema_version=2 WHERE id=1');
        }
        const record = meta.schema_version === 2 || initialize ? this.#record() : null;
        return perform(sql, record, context);
      });
    });
  }
  enrollmentSnapshot(context) {
    return this.#enrollmentRun(context, false, (_sql, record, verified) => this.#summary(verified, record));
  }
  prepareEnrollment(context, value) {
    const prepared = preparedEnrollment(value);
    return this.#enrollmentRun(context, true, (sql, record, verified) => {
      if (record) {
        const previous = preparedEnrollment({ enrollmentId: record.enrollmentId, challengeDigest: record.challengeDigest, createdAt: record.createdAt, expiresAt: record.expiresAt });
        requireEnrollment(JSON.stringify(previous) === JSON.stringify(prepared));
        return this.#summary(verified, record);
      }
      requireEnrollment(Date.now() >= prepared.createdAt && Date.now() < prepared.expiresAt);
      const next = { ...prepared, status: 'pending' };
      sql.exec('INSERT INTO node_enrollment VALUES(1,?)', JSON.stringify(next));
      return this.#summary(verified, next);
    });
  }
  async joinEnrollment(value, challenge, request) {
    const context = this.#context(value), input = joinInput(request), proof = await joinChallengeDigest(context, input.enrollmentId, challenge);
    return this.#enrollmentRun(context, false, (sql, record, verified) => {
      requireEnrollment(record && record.enrollmentId === input.enrollmentId && crypto.subtle.timingSafeEqual(new TextEncoder().encode(proof), new TextEncoder().encode(record.challengeDigest)));
      if (record.status === 'joined') {
        requireEnrollment(JSON.stringify(record.input) === JSON.stringify(input));
        return this.#summary(verified, record); // 精确原回执可重送，不再次消费能力。
      }
      const now = Date.now(); requireEnrollment(now >= record.createdAt && now < record.expiresAt);
      const joined = nodeEnrollment({ ...record, status: 'joined', input, joinedAt: now });
      sql.exec('UPDATE node_enrollment SET state=? WHERE id=1', JSON.stringify(joined));
      return this.#summary(verified, joined);
    });
  }
  async credentialIdentity(value, role, token) {
    nodeRole(role); const proof = await credentialDigest(token);
    return this.#enrollmentRun(value, false, (_sql, record, verified) => {
      requireCredential(record?.status === 'joined');
      const digest = role === 'execute' ? record.input.executeDigest : record.input.observeDigest;
      requireCredential(crypto.subtle.timingSafeEqual(new TextEncoder().encode(proof), new TextEncoder().encode(digest)));
      return identityResult(verified, record.enrollmentId, role);
    }, 'ENABLE_NODE_CREDENTIALS');
  }
}
