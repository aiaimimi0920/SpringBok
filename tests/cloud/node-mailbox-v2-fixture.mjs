// 只读回退夹具：冻结 main 448d53a 的 schema 2 NodeMailbox；仅改相对 import 路径。
import { DurableObject } from 'cloudflare:workers';
import { nodeContext, nodeMailboxName, nodeLedger, probePlan, nodeTransition, verifyNodePlans } from '../../cloud/node-protocol.mjs';
import { preparedEnrollment, nodeEnrollment, joinInput, joinChallengeDigest, requireEnrollment } from '../../cloud/enrollment-contract.mjs';
import { nodeRole, credentialDigest, identityResult, requireCredential } from '../../cloud/credential-contract.mjs';
import { channelInput, channelResult } from '../../cloud/node-channel-contract.mjs';

// 保留旧内部 probe；新通道只在当前 joined 角色认证的同一事务内领取和回报。
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
        this.#context(context); requireEnrollment(this.env[feature] === 'yes');
        const sql = this.ctx.storage.sql, meta = sql.exec('SELECT schema_version FROM node_meta').one();
        if (meta.schema_version === 1 && initialize) {
          sql.exec('CREATE TABLE node_enrollment (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
          sql.exec('UPDATE node_meta SET schema_version=2 WHERE id=1');
        }
        const record = meta.schema_version === 2 || initialize ? this.#record() : null;
        return perform(sql, record, context, this.#read(context, false));
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
  async #credentialRun(value, role, token, perform) {
    nodeRole(role); const proof = await credentialDigest(token);
    return this.#enrollmentRun(value, false, (sql, record, verified, ledger) => {
      requireCredential(record?.status === 'joined');
      const digest = role === 'execute' ? record.input.executeDigest : record.input.observeDigest;
      requireCredential(crypto.subtle.timingSafeEqual(new TextEncoder().encode(proof), new TextEncoder().encode(digest)));
      return perform(sql, record, verified, ledger);
    }, 'ENABLE_NODE_CREDENTIALS');
  }
  credentialIdentity(value, role, token) {
    return this.#credentialRun(value, role, token, (_sql, record, verified) => identityResult(verified, record.enrollmentId, role));
  }
  #probeTransition(sql, ledger, context, operation, input) {
    const result = nodeTransition(ledger, context, operation, input, Date.now());
    if (result.changed) sql.exec('UPDATE node_ledger SET state=? WHERE id=1', JSON.stringify(result.state));
    return result.response;
  }
  credentialProbe(value, role, token, enrollmentId, operation, input) {
    requireCredential(this.env.ENABLE_NODE_CHANNEL === 'yes' && role === 'execute');
    const request = channelInput(operation, input);
    return this.#credentialRun(value, role, token, (sql, record, verified, ledger) => {
      requireCredential(this.env.ENABLE_NODE_CHANNEL === 'yes' && record.enrollmentId === enrollmentId);
      return channelResult(verified, record.enrollmentId, this.#probeTransition(sql, ledger, verified, operation === 'poll' ? 'pollProbe' : 'reportProbe', request));
    });
  }
  async adminProbe(value, operation, request) {
    requireCredential(this.env.ENABLE_NODE_CREDENTIALS === 'yes' && ['snapshot', 'submit'].includes(operation));
    const context = this.#context(value), input = operation === 'submit' ? await probePlan(context, request) : null;
    return this.#enrollmentRun(context, false, (sql, record, verified, ledger) => {
      requireCredential(this.env.ENABLE_NODE_CREDENTIALS === 'yes' && record?.status === 'joined');
      const scope = { mode: 'authenticated-node-probe-only', executionReady: false, protocolVersion: 2, ...verified, enrollmentId: record.enrollmentId };
      if (operation === 'snapshot') return { ...scope, ...ledger };
      return { ...scope, result: this.#probeTransition(sql, ledger, verified, 'submitProbe', input) };
    }, 'ENABLE_NODE_CHANNEL');
  }
}
