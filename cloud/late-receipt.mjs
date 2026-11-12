import { validateResult } from '../src/sba/contract.mjs';
import { canonicalSba, exactSba, requireSba } from './sba-control.mjs';

// Only missing observations may be recovered; an application UNKNOWN is immutable.
export const missingDeadlineReceipt = job => job?.status === 'unknown' &&
  job.errorCode === 'SBA_TASK_DEADLINE' && job.result === null &&
  typeof job.permitId === 'string' && Number.isSafeInteger(job.runId) && job.runId > 0;

export function validateLateEnvelope(job, policy, envelope) {
  requireSba(missingDeadlineReceipt(job));
  exactSba(envelope, ['schemaVersion','runId','runAttempt','executorSha','requestDigest','permitId','result']);
  requireSba(envelope.schemaVersion === 1 && envelope.runAttempt === 1 &&
    envelope.runId === job.runId && envelope.executorSha === policy.github.executorSha &&
    envelope.requestDigest === job.requestDigest && envelope.permitId === job.permitId);
  return validateResult(envelope.result, job.request);
}

export function recoveredJob(job, policy, record) {
  exactSba(record, ['original','envelope','observedAt']);
  requireSba(canonicalSba(record.original) === canonicalSba(job) &&
    Number.isSafeInteger(record.observedAt) && record.observedAt >= job.resultDeadline);
  const result = validateLateEnvelope(job, policy, record.envelope);
  return {...job, result, status: result.status, errorCode: result.errorCode ?? null};
}
