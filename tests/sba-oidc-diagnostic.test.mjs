import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { oidcContextProjection } from '../scripts/sba-oidc-diagnostic.mjs';
test('OIDC context projection contains only fixed field names, types and booleans', () => {
  const value = oidcContextProjection({ event_name: 'workflow_dispatch', runner_environment: 'github-hosted', run_attempt: '1',
    job_workflow_ref: 'synthetic-private-ref', environment: null, head_ref: '', base_ref: { private: 'secret' },
    unexpected: 'synthetic-private-token' });
  assert.equal(value.event_name.matchesExpected, true); assert.equal(value.environment.type, 'null');
  assert.equal(value.head_ref.emptyString, true); assert.equal(value.base_ref.type, 'other');
  assert.equal(value.job_workflow_sha.present, false); assert.equal(value.job_workflow_ref.matchesExpected, false);
  assert.doesNotMatch(JSON.stringify(value), /synthetic|secret|private|unexpected/);
  for (const field of Object.values(value)) for (const [key, entry] of Object.entries(field))
    assert.equal(typeof entry, key === 'type' ? 'string' : 'boolean');
});
test('diagnostic CLI outside its exact hosted tag exits without network or raw environment output', () => {
  let result;
  try { execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/sba-oidc-diagnostic.mjs', import.meta.url))],
    { env: { ...process.env, GITHUB_ACTIONS: 'false', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-private-token' },
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { result = error; }
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'SBA_OIDC_DIAGNOSTIC_UNCONFIRMED');
});
