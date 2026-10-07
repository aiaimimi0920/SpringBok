import test from 'node:test';
import assert from 'node:assert/strict';
import { sbaAuthorizedRecovery, sbaDigest } from '../cloud/sba-control.mjs';
const policy = { github: { repository: 'owner/executor', repositoryId: 123, applicationRepository: 'owner/application',
  workflowId: 99, workflowPath: '.github/workflows/sba-execute.yml', executorSha: 'a'.repeat(40), ref: `sba-executor-${'a'.repeat(40)}` },
  sourceSha: 'b'.repeat(40), environment: 'staging', configuration: {}, secretNames: [], runnerOrigin: 'https://runner.example.invalid' };
const now = Date.now(), approved = { taskId: 'approved-task', runId: 456, requestDigest: 'c'.repeat(64), resultDigest: 'd'.repeat(64),
  oldPolicyDigest: await sbaDigest(policy), executorSha: 'e'.repeat(40), sourceSha: 'f'.repeat(40), evidenceDigest: 'c'.repeat(64), approvedAt: now, expiresAt: now + 3600000 };
const env = { ENABLE_SBA: 'yes', SBA_TASKS: {}, SBA_GITHUB_TOKEN: 'synthetic', ADMIN_ORIGIN: 'https://admin.example.invalid', SBA_POLICY: JSON.stringify(policy) };
test('operator recovery defaults closed and cannot change target configuration or self-authorize with request input', async () => {
  await assert.rejects(sbaAuthorizedRecovery(env, policy));
  for (const changed of [{ runId: 0 }, { executorSha: policy.github.executorSha }, { sourceSha: policy.sourceSha },
    { approvedAt: now + 3600000 }, { expiresAt: now - 1 }, { expiresAt: now + 3600001 },
    { evidenceDigest: 'raw-private-url' }, { configuration: { arbitrary: true } }, { oldPolicyDigest: 'a'.repeat(64) }])
    await assert.rejects(sbaAuthorizedRecovery({ ...env, SBA_OPERATOR_RECOVERY: JSON.stringify({ ...approved, ...changed }) }, policy));
  const { nextPolicy } = await sbaAuthorizedRecovery({ ...env, SBA_OPERATOR_RECOVERY: JSON.stringify(approved) }, policy);
  const expected = structuredClone(policy); expected.github.executorSha = approved.executorSha;
  expected.github.ref = `sba-executor-${approved.executorSha}`; expected.sourceSha = approved.sourceSha;
  assert.deepEqual(nextPolicy, expected);
});
