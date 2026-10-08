import { signSession, sameProof } from './access.mjs';
import { exactSba, requireSba, sbaPolicy, sbaStub, sbaDigest } from './sba-control.mjs';
import { accountStub } from './connected-store.mjs';
import { importKeys, inspectImported, importComponents } from './service-import.mjs';
import { importedState } from './service-api.mjs';
import { readApplication } from './service-catalog.mjs';

const vaultFor = (env, owner) => env.CONNECTIONS.get(env.CONNECTIONS.idFromName(`connections/v1/${owner}`));
const at = (object, path) => path.reduce((value, key) => value?.[key], object);
export const legacyImportDigest = job => sbaDigest({ request: job.request, status: job.status, runId: job.runId, result: job.result });
export async function commitImported(env, owner, candidate) {
  const app = candidate.instance.application;
  await accountStub(env, candidate.instance.accountId).registerImported(owner, candidate.id, candidate.instance.accountId, importKeys(candidate), { id: app.id, repository: app.repository });
  return importedState(await vaultFor(env, owner).saveImported(owner, candidate));
}
async function confirmImport(session, draft, candidate) {
  const expiresAt = Date.now() + 120000;
  return { draft, candidate, expiresAt, confirmation: await signSession(session, 'service-import', [draft, candidate.digest, expiresAt]) };
}
function checkConfirmation(session, input) {
  exactSba(input, ['draft', 'candidate', 'expiresAt', 'confirmation']);
  requireSba(Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000);
  return signSession(session, 'service-import', [input.draft, input.candidate.digest, input.expiresAt]).then(proof => requireSba(sameProof(input.confirmation, proof)));
}
export async function serviceImportRequest(env, session, mode, input) {
  requireSba(!session.automation);
  const vault = vaultFor(env, session.actor);
  if (mode === 'import-preview') return confirmImport(session, input, await vault.importDraft(session.actor, input));
  requireSba(mode === 'import-submit'); await checkConfirmation(session, input);
  const candidate = await vault.importDraft(session.actor, input.draft);
  requireSba(candidate.digest === input.candidate.digest && input.expiresAt > Date.now());
  return commitImported(env, session.actor, candidate);
}

// The optional automation path can only import the original fixed deployment.
// It cannot supply accounts, resource IDs, owner IDs, secrets or arbitrary URLs.
export async function legacyImportRequest(env, session, mode, input) {
  const policy = sbaPolicy(env), job = await sbaStub(env, policy).inspect(session.actor);
  requireSba(job && ['succeeded', 'deployed-unverified', 'unknown'].includes(job.status) && typeof job.permitId === 'string' && job.permitId.length > 0 && job.result);
  const draft = mode === 'import-preview' ? input : input.draft;
  exactSba(draft, ['taskId', 'definitionSha']);
  requireSba(draft.taskId === job.request.taskId && /^[a-f0-9]{40}$/.test(draft.definitionSha));
  if (session.automation) {
    const approval = JSON.parse(env.SBA_IMPORT_APPROVAL ?? 'null');
    exactSba(approval, ['taskId', 'definitionSha', 'jobDigest', 'issuedAt', 'expiresAt']);
    requireSba(approval.taskId === draft.taskId && approval.definitionSha === draft.definitionSha && approval.jobDigest === await legacyImportDigest(job) &&
      Number.isSafeInteger(approval.issuedAt) && approval.issuedAt > 0 && approval.issuedAt <= Date.now() &&
      Number.isSafeInteger(approval.expiresAt) && approval.expiresAt > Date.now() && approval.expiresAt - approval.issuedAt <= 900000 && approval.expiresAt <= session.automation.expiresAt);
  }
  if (mode === 'import-submit') await checkConfirmation(session, input); else requireSba(mode === 'import-preview');
  const application = await readApplication(env, policy.github.applicationRepository, draft.definitionSha, env.SBA_GITHUB_TOKEN);
  requireSba(application.manifest.id === job.request.applicationId);
  const config = job.request.configuration, accountId = at(config, application.declaration.accountPath);
  const components = Object.fromEntries(importComponents(application).map(component => [component.key, at(config, component.key.split('.'))]));
  const secrets = JSON.parse(env.SBA_APPLICATION_SECRETS ?? '{}'); requireSba(typeof secrets.CLOUDFLARE_API_TOKEN === 'string');
  const vault = vaultFor(env, session.actor), connections = (await vault.snapshot(session.actor)).connections;
  const cloudflare = connections.find(row => row.provider === 'cloudflare' && row.target === accountId && row.state === 'verified');
  const github = connections.find(row => row.provider === 'github' && row.state === 'verified' && row.deploymentAvailable !== false && (row.target === application.repository || row.target.startsWith('@')));
  const references = cloudflare && github ? { cloudflare: { id: cloudflare.id, revision: cloudflare.revision }, github: { id: github.id, revision: github.revision } } : null;
  const candidate = await inspectImported(session.actor, application, accountId, secrets.CLOUDFLARE_API_TOKEN, components, references, job);
  requireSba(await sbaDigest(await sbaStub(env, policy).inspect(session.actor)) === await sbaDigest(job));
  if (session.automation) requireSba(JSON.parse(env.SBA_IMPORT_APPROVAL).expiresAt > Date.now());
  if (mode === 'import-preview') return confirmImport(session, draft, candidate);
  requireSba(candidate.digest === input.candidate.digest && input.expiresAt > Date.now());
  return commitImported(env, session.actor, candidate);
}
