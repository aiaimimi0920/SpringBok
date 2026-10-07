import { DurableObject } from 'cloudflare:workers';
import { validateResult } from '../src/sba/contract.mjs';
import { sbaPolicy, sbaRequest, sbaDigest, canonicalSba, requireSba, exactSba, sbaObjectName, sbaSummary, sbaExecutorTransition, sbaAuthorizedRecovery, sbaRecoveryApproval, sbaRecoveryNextPolicy } from './sba-control.mjs';
const statuses = ['dispatching', 'dispatched', 'dispatch-unknown', 'running', 'succeeded', 'deployed-unverified', 'failed', 'unknown'];
const id = v => Number.isSafeInteger(v) && v > 0;

// 独立的首次部署槽；旧 fixture/节点账本不复用、不改名、不迁移。
export class SbaDeployment extends DurableObject {
  async #run(actor, operation) {
    const policy = sbaPolicy(this.env);
    requireSba(this.ctx.id.toString() === this.env.SBA_TASKS.idFromName(sbaObjectName(policy)).toString());
    requireSba(actor === null || (typeof actor === 'string' && /^[a-f0-9]{64}$/.test(actor)));
    return this.ctx.blockConcurrencyWhile(async () => {
      const policyDigest = await sbaDigest(policy);
      let initialized = false;
      let recovered = false;
      let job = this.ctx.storage.transactionSync(() => {
        const tables = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sba_meta','sba_deployment')").toArray();
        if (!tables.length) return null;
        requireSba(tables.length === 2);
        const meta = this.ctx.storage.sql.exec('SELECT * FROM sba_meta').toArray();
        const rows = this.ctx.storage.sql.exec('SELECT * FROM sba_deployment').toArray();
        requireSba(meta.length === 1 && meta[0].id === 1 && [1, 2].includes(meta[0].version) && meta[0].policy_digest === policyDigest && rows.length === 1 && rows[0].id === 1);
        initialized = true;
        recovered = meta[0].version === 2;
        return JSON.parse(rows[0].state);
      });
      const history = [];
      let historyHead = null;
      const historyTables = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sba_unstarted_history','sba_recovery_meta')").toArray();
      requireSba(historyTables.length === (recovered ? 2 : 0));
      if (historyTables.length) {
        requireSba(historyTables.length === 2);
        const recoveryMeta = this.ctx.storage.sql.exec('SELECT * FROM sba_recovery_meta').toArray();
        const rows = this.ctx.storage.sql.exec('SELECT * FROM sba_unstarted_history ORDER BY sequence').toArray();
        requireSba(initialized && rows.length > 0 && rows.length <= 20 && recoveryMeta.length === 1 &&
          recoveryMeta[0].id === 1 && recoveryMeta[0].history_count === rows.length);
        for (const row of rows) {
          const record = JSON.parse(row.record);
          const authorized = Object.hasOwn(record, 'approval');
          exactSba(record, ['job', 'policy', 'proof', 'nextPolicyDigest', 'previousDigest', ...(authorized ? ['approval', 'outcome'] : [])]);
          const previousPolicy = sbaPolicy({ ...this.env, SBA_POLICY: JSON.stringify(record.policy) });
          requireSba(row.sequence === history.length + 1 && record.previousDigest === historyHead &&
            (!history.length || history.at(-1).nextPolicyDigest === await sbaDigest(previousPolicy)) &&
            row.task_id === record.job.request.taskId && row.actor === record.job.actor &&
            (actor === null || row.actor === actor) && record.job.requestDigest === await sbaDigest(record.job.request) &&
            canonicalSba(record.job.request) === canonicalSba(sbaRequest(previousPolicy, row.task_id, record.job.manifest)) &&
            row.digest === await sbaDigest(record));
          if (authorized) {
            const a = sbaRecoveryApproval(record.approval), j = record.job, p = record.proof;
            exactSba(j, ['actor', 'request', 'manifest', 'requestDigest', 'status', 'runId', 'submittedAt', 'permitDeadline', 'permitAt', 'permitId', 'resultDeadline', 'result', 'errorCode']);
            exactSba(p, ['runId', 'requestDigest', 'executorSha', 'conclusion', 'verifiedAt']);
            requireSba(record.outcome === 'operator-authorized-retry' && j.status === 'unknown' && j.result?.status === 'unknown' &&
              typeof j.permitId === 'string' && /^[a-f0-9]{64}$/.test(j.permitId) && id(j.permitAt) && id(j.runId) &&
              id(j.submittedAt) && j.permitDeadline === j.submittedAt + 900000 &&
              j.resultDeadline === j.permitAt + j.manifest.actions.deploy.timeoutSeconds * 1000 + 600000 && j.errorCode === (j.result.errorCode ?? null) &&
              a.taskId === row.task_id && a.runId === j.runId && a.requestDigest === j.requestDigest && a.resultDigest === await sbaDigest(j.result) &&
              a.oldPolicyDigest === await sbaDigest(previousPolicy) && record.nextPolicyDigest === await sbaDigest(sbaRecoveryNextPolicy(this.env, previousPolicy, a)) &&
              p.runId === j.runId && p.requestDigest === j.requestDigest && p.executorSha === previousPolicy.github.executorSha && p.conclusion === 'success' &&
              id(p.verifiedAt) && p.verifiedAt >= a.approvedAt && p.verifiedAt < a.expiresAt);
            validateResult(j.result, j.request);
          } else requireSba(record.job.permitId === null && record.job.permitAt === null && record.job.result === null);
          historyHead = row.digest;
          history.push({ taskId: row.task_id, outcome: authorized ? record.outcome : 'not-executed', job: sbaSummary(record.job).job,
            executorSha: previousPolicy.github.executorSha, proof: record.proof, nextPolicyDigest: record.nextPolicyDigest,
            ...(authorized ? { approval: record.approval } : {}) });
        }
        requireSba(recoveryMeta[0].head_digest === historyHead && history.at(-1).nextPolicyDigest === policyDigest);
      }
      requireSba(!initialized || job !== null || history.length > 0);
      if (job) {
        exactSba(job, ['actor', 'request', 'manifest', 'requestDigest', 'status', 'runId', 'submittedAt', 'permitDeadline', 'permitAt', 'permitId', 'resultDeadline', 'result', 'errorCode']);
        requireSba(typeof job.actor === 'string' && /^[a-f0-9]{64}$/.test(job.actor) && (actor === null || job.actor === actor));
        requireSba(canonicalSba(job.request) === canonicalSba(sbaRequest(policy, job.request.taskId, job.manifest)) && await sbaDigest(job.request) === job.requestDigest);
        requireSba(statuses.includes(job.status) && (job.runId === null || id(job.runId)) && Number.isSafeInteger(job.submittedAt) && job.submittedAt > 0 && job.permitDeadline === job.submittedAt + 900000);
        requireSba((job.permitId === null && job.permitAt === null && job.resultDeadline === null) ||
          (typeof job.permitId === 'string' && /^[a-f0-9]{64}$/.test(job.permitId) && id(job.permitAt) && id(job.runId) && job.resultDeadline === job.permitAt + job.manifest.actions.deploy.timeoutSeconds * 1000 + 600000));
        requireSba(job.status !== 'running' || (job.permitId !== null && job.result === null));
        requireSba(!['dispatching', 'dispatched', 'dispatch-unknown'].includes(job.status) || (job.permitId === null && job.result === null));
        requireSba(job.status !== 'dispatched' || id(job.runId));
        requireSba(job.result === null || (job.permitId !== null && job.result.status === job.status));
        requireSba(job.errorCode === null || (typeof job.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(job.errorCode)));
        requireSba(!['succeeded', 'deployed-unverified', 'failed'].includes(job.status) || (job.permitId !== null && job.result?.status === job.status));
        if (job.result !== null) validateResult(job.result, job.request);
        if ((['dispatching', 'dispatched', 'dispatch-unknown'].includes(job.status) && Date.now() >= job.permitDeadline) ||
            (job.status === 'running' && Date.now() >= job.resultDeadline)) {
          job.status = 'unknown'; job.errorCode = 'SBA_TASK_DEADLINE'; this.#write(job);
        }
      }
      const save = value => {
        this.ctx.storage.transactionSync(() => {
          if (!initialized) {
            this.ctx.storage.sql.exec('CREATE TABLE sba_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, policy_digest TEXT NOT NULL)');
            this.ctx.storage.sql.exec('CREATE TABLE sba_deployment (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
            this.ctx.storage.sql.exec('INSERT INTO sba_meta VALUES(1,1,?)', policyDigest);
            this.ctx.storage.sql.exec('INSERT INTO sba_deployment VALUES(1,?)', JSON.stringify(value));
            initialized = true;
          } else this.ctx.storage.sql.exec('UPDATE sba_deployment SET state=? WHERE id=1', JSON.stringify(value));
        });
        job = value;
      };
      return operation(job, save, policy, history, historyHead);
    });
  }
  #write(job) { this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec('UPDATE sba_deployment SET state=? WHERE id=1', JSON.stringify(job))); }
  snapshot(actor) { return this.#run(actor, (job, _save, _policy, history) => ({ ...sbaSummary(job), ...(history.length ? { history } : {}) })); }
  inspect(actor) { return this.#run(actor, job => job); }
  begin(actor, input) {
    requireSba(typeof actor === 'string' && /^[a-f0-9]{64}$/.test(actor));
    return this.#run(actor, async (job, save, policy, history) => {
      exactSba(input, ['request', 'manifest']);
      const request = sbaRequest(policy, input.request.taskId, input.manifest);
      requireSba(canonicalSba(request) === canonicalSba(input.request));
      requireSba(!history.some(entry => entry.taskId === request.taskId));
      if (job) {
        requireSba(canonicalSba(job.request) === canonicalSba(request) && canonicalSba(job.manifest) === canonicalSba(input.manifest));
        return { dispatch: false, snapshot: sbaSummary(job) };
      }
      const now = Date.now();
      const created = { actor, request, manifest: input.manifest, requestDigest: await sbaDigest(request), status: 'dispatching', runId: null,
        submittedAt: now, permitDeadline: now + 900000, permitAt: null, permitId: null, resultDeadline: null, result: null, errorCode: null };
      save(created); // 成功持久化后才把唯一 dispatch 权交付调用方。
      return { dispatch: true, snapshot: sbaSummary(created) };
    });
  }
  recoverUnstarted(actor, taskId, nextPolicy, proof) {
    requireSba(typeof actor === 'string' && /^[a-f0-9]{64}$/.test(actor));
    return this.#run(actor, async (job, _save, policy, history, historyHead) => {
      requireSba(job && job.request.taskId === taskId && id(job.runId) && job.permitId === null &&
        job.permitAt === null && job.resultDeadline === null && job.result === null &&
        ['dispatched', 'unknown'].includes(job.status) && history.length < 20);
      requireSba(canonicalSba(nextPolicy) === canonicalSba(sbaExecutorTransition(this.env, policy, nextPolicy?.github?.executorSha)));
      exactSba(proof, ['runId', 'requestDigest', 'executorSha', 'conclusion', 'verifiedAt']);
      requireSba(proof.runId === job.runId && proof.requestDigest === job.requestDigest && proof.executorSha === policy.github.executorSha &&
        ['failure', 'cancelled', 'timed_out'].includes(proof.conclusion) && id(proof.verifiedAt) &&
        proof.verifiedAt <= Date.now() && proof.verifiedAt > Date.now() - 60000);
      const nextPolicyDigest = await sbaDigest(nextPolicy), record = { job, policy, proof, nextPolicyDigest, previousDigest: historyHead };
      const recordDigest = await sbaDigest(record);
      // 同一 SQLite 事务保留原始任务和 policy，再撤销旧授权；绝不删除历史或复用旧 task ID。
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sba_unstarted_history (sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, record TEXT NOT NULL, digest TEXT NOT NULL)');
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sba_recovery_meta (id INTEGER PRIMARY KEY CHECK(id=1), history_count INTEGER NOT NULL, head_digest TEXT NOT NULL)');
        this.ctx.storage.sql.exec('INSERT INTO sba_unstarted_history (task_id,actor,record,digest) VALUES(?,?,?,?)', taskId, actor, JSON.stringify(record), recordDigest);
        this.ctx.storage.sql.exec('INSERT INTO sba_recovery_meta VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET history_count=excluded.history_count,head_digest=excluded.head_digest', history.length + 1, recordDigest);
        this.ctx.storage.sql.exec('UPDATE sba_deployment SET state=? WHERE id=1', 'null');
        this.ctx.storage.sql.exec('UPDATE sba_meta SET version=2,policy_digest=? WHERE id=1', nextPolicyDigest);
      });
      // 旧配置从此失败关闭；发布精确 nextPolicy 后才允许新任务，不在此 dispatch。
      return { policyTransitionPending: true, nextPolicyDigest, archivedTaskId: taskId, outcome: 'not-executed' };
    });
  }
  recoverAuthorized(actor, taskId, nextPolicy, proof) {
    requireSba(typeof actor === 'string' && /^[a-f0-9]{64}$/.test(actor));
    return this.#run(actor, async (job, _save, policy, history, historyHead) => {
      const approved = await sbaAuthorizedRecovery(this.env, policy), a = approved.approval;
      requireSba(job && job.status === 'unknown' && job.result?.status === 'unknown' && job.permitId !== null &&
        taskId === a.taskId && job.request.taskId === a.taskId && job.runId === a.runId && job.requestDigest === a.requestDigest &&
        await sbaDigest(job.result) === a.resultDigest && history.length < 20 && canonicalSba(nextPolicy) === canonicalSba(approved.nextPolicy));
      exactSba(proof, ['runId', 'requestDigest', 'executorSha', 'conclusion', 'verifiedAt']);
      requireSba(proof.runId === job.runId && proof.requestDigest === job.requestDigest && proof.executorSha === policy.github.executorSha &&
        proof.conclusion === 'success' && id(proof.verifiedAt) && proof.verifiedAt <= Date.now() && proof.verifiedAt > Date.now() - 60000 &&
        proof.verifiedAt >= a.approvedAt && proof.verifiedAt < a.expiresAt);
      const nextPolicyDigest = await sbaDigest(nextPolicy), record = { job, policy, proof, nextPolicyDigest, previousDigest: historyHead,
        approval: a, outcome: 'operator-authorized-retry' }, recordDigest = await sbaDigest(record);
      // 这是显式的新尝试批准，不是“未执行”的证明；保留许可、原 unknown 结果及批准证据。
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sba_unstarted_history (sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, record TEXT NOT NULL, digest TEXT NOT NULL)');
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sba_recovery_meta (id INTEGER PRIMARY KEY CHECK(id=1), history_count INTEGER NOT NULL, head_digest TEXT NOT NULL)');
        this.ctx.storage.sql.exec('INSERT INTO sba_unstarted_history (task_id,actor,record,digest) VALUES(?,?,?,?)', taskId, actor, JSON.stringify(record), recordDigest);
        this.ctx.storage.sql.exec('INSERT INTO sba_recovery_meta VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET history_count=excluded.history_count,head_digest=excluded.head_digest', history.length + 1, recordDigest);
        this.ctx.storage.sql.exec('UPDATE sba_deployment SET state=? WHERE id=1', 'null');
        this.ctx.storage.sql.exec('UPDATE sba_meta SET version=2,policy_digest=? WHERE id=1', nextPolicyDigest);
      });
      return { policyTransitionPending: true, nextPolicyDigest, archivedTaskId: taskId, outcome: record.outcome };
    });
  }
  attachRun(actor, taskId, outcome) {
    return this.#run(actor, (job, save) => {
      requireSba(job && job.request.taskId === taskId && outcome.requestDigest === job.requestDigest);
      requireSba(['dispatched', 'unknown'].includes(outcome.status));
      if (outcome.status === 'dispatched') {
        requireSba(id(outcome.runId) && (job.runId === null || job.runId === outcome.runId));
        if (['dispatching', 'dispatched', 'dispatch-unknown'].includes(job.status)) { job.runId = outcome.runId; job.status = 'dispatched'; save(job); }
      } else if (job.status === 'dispatching') { job.status = 'dispatch-unknown'; job.errorCode = 'SBA_GITHUB_DISPATCH_UNKNOWN'; save(job); }
      return sbaSummary(job);
    });
  }
  permit(taskId, requestDigest, runId) {
    return this.#run(null, (job, save) => {
      requireSba(job && job.request.taskId === taskId && job.requestDigest === requestDigest && id(runId));
      requireSba(['dispatching', 'dispatched', 'dispatch-unknown'].includes(job.status) && job.permitId === null && (job.runId === null || job.runId === runId));
      job.runId = runId; job.permitId = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      job.permitAt = Date.now(); job.resultDeadline = job.permitAt + job.manifest.actions.deploy.timeoutSeconds * 1000 + 600000;
      job.status = 'running'; job.errorCode = null; save(job);
      return { permitId: job.permitId, request: job.request, manifest: job.manifest, requestDigest: job.requestDigest };
    });
  }
  // 内部 RPC 供已验 OIDC 的适配层核对任务；不是匿名 HTTP 查询。
  pending(taskId, requestDigest) {
    return this.#run(null, job => { requireSba(job && job.request.taskId === taskId && job.requestDigest === requestDigest); return job; });
  }
  settle(actor, envelope) {
    return this.#run(actor, (job, save, policy) => {
      exactSba(envelope, ['schemaVersion', 'runId', 'runAttempt', 'executorSha', 'requestDigest', 'permitId', 'result']);
      requireSba(envelope.schemaVersion === 1);
      requireSba(job && job.permitId !== null && envelope.runId === job.runId && envelope.permitId === job.permitId && envelope.requestDigest === job.requestDigest && envelope.executorSha === policy.github.executorSha && envelope.runAttempt === 1);
      const result = validateResult(envelope.result, job.request);
      if (job.result !== null) { requireSba(canonicalSba(result) === canonicalSba(job.result)); return sbaSummary(job); }
      requireSba(job.status === 'running');
      job.result = result; job.status = result.status; job.errorCode = result.errorCode ?? null; save(job);
      return sbaSummary(job);
    });
  }
  markUnknown(actor, taskId) {
    return this.#run(actor, (job, save) => {
      requireSba(job && job.request.taskId === taskId);
      if (['dispatching', 'dispatched', 'dispatch-unknown', 'running'].includes(job.status)) { job.status = 'unknown'; job.errorCode = 'SBA_RUN_UNCONFIRMED'; save(job); }
      return sbaSummary(job);
    });
  }
}
