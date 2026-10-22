import { ownerId } from './connections-contract.mjs';
import { canonicalSba, exactSba, requireSba } from './sba-control.mjs';

const fields = ['owner', 'taskId', 'instanceId', 'previousTaskId', 'repository', 'sourceSha', 'planDigest'];
export function cancellationIdentity(value) {
  exactSba(value, fields); ownerId(value.owner);
  requireSba([value.taskId, value.instanceId, value.previousTaskId].every(id => typeof id === 'string' && /^dc-[a-f0-9]{32}$/.test(id)) &&
    value.taskId !== value.instanceId && value.taskId !== value.previousTaskId &&
    typeof value.repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.repository) &&
    typeof value.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(value.sourceSha) &&
    typeof value.planDigest === 'string' && /^[a-f0-9]{64}$/.test(value.planDigest));
  return value;
}
export function cancellationRecord(value) {
  exactSba(value, [...fields, 'cancelledAt']);
  cancellationIdentity(Object.fromEntries(fields.map(key => [key, value[key]])));
  requireSba(Number.isSafeInteger(value.cancelledAt) && value.cancelledAt > 0);
  return value;
}
export const sameCancellation = (record, identity) => {
  cancellationRecord(record); cancellationIdentity(identity);
  return canonicalSba(Object.fromEntries(fields.map(key => [key, record[key]]))) === canonicalSba(identity);
};
