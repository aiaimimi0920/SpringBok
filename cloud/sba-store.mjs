import { DurableObject } from 'cloudflare:workers';
import { validateResult } from '../src/sba/contract.mjs';
import { sbaPolicy, sbaRequest, sbaDigest, canonicalSba, requireSba, exactSba, sbaObjectName, sbaSummary } from './sba-control.mjs';
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
      let job = this.ctx.storage.transactionSync(() => {
        const tables = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sba_meta','sba_deployment')").toArray();
        if (!tables.length) return null;
        requireSba(tables.length === 2);
        const meta = this.ctx.storage.sql.exec('SELECT * FROM sba_meta').toArray();
        const rows = this.ctx.storage.sql.exec('SELECT * FROM sba_deployment').toArray();
        requireSba(meta.length === 1 && meta[0].id === 1 && meta[0].version === 1 && meta[0].policy_digest === policyDigest && rows.length === 1 && rows[0].id === 1);
        return JSON.parse(rows[0].state);
      });
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
          if (!job) {
            this.ctx.storage.sql.exec('CREATE TABLE sba_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, policy_digest TEXT NOT NULL)');
            this.ctx.storage.sql.exec('CREATE TABLE sba_deployment (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
            this.ctx.storage.sql.exec('INSERT INTO sba_meta VALUES(1,1,?)', policyDigest);
            this.ctx.storage.sql.exec('INSERT INTO sba_deployment VALUES(1,?)', JSON.stringify(value));
          } else this.ctx.storage.sql.exec('UPDATE sba_deployment SET state=? WHERE id=1', JSON.stringify(value));
        });
        job = value;
      };
      return operation(job, save, policy);
    });
  }
  #write(job) { this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec('UPDATE sba_deployment SET state=? WHERE id=1', JSON.stringify(job))); }
  snapshot(actor) { return this.#run(actor, job => sbaSummary(job)); }
  inspect(actor) { return this.#run(actor, job => job); }
  begin(actor, input) {
    requireSba(typeof actor === 'string' && /^[a-f0-9]{64}$/.test(actor));
    return this.#run(actor, async (job, save, policy) => {
      exactSba(input, ['request', 'manifest']);
      const request = sbaRequest(policy, input.request.taskId, input.manifest);
      requireSba(canonicalSba(request) === canonicalSba(input.request));
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
