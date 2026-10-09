import { exactSba, requireSba } from './sba-control.mjs';
import { connectionId } from './connections-contract.mjs';
import { sealToken, openToken } from './connections-crypto.mjs';
import { connectionReference, deploymentValue, setDeploymentValue } from './deployment-contract.mjs';

// Separate storage and AAD purpose: these are application bootstrap passwords,
// never provider API tokens. No read API returns plaintext or a password digest.
function guard(vault, owner) {
  vault.guard(owner);
  vault.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS admin_profiles (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, sealed TEXT NOT NULL)');
  vault.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS admin_task_secrets (task TEXT NOT NULL, name TEXT NOT NULL, metadata TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY(task,name))');
}
function stored(vault, id) { return vault.ctx.storage.sql.exec('SELECT * FROM admin_profiles WHERE id=?', id).toArray()[0]; }
function active(vault, ref) {
  connectionReference(ref); const row = stored(vault, ref.id); requireSba(row);
  const metadata = JSON.parse(row.metadata);
  requireSba(metadata.revision === ref.revision && metadata.active && (!metadata.expiresAt || metadata.expiresAt > Date.now()));
  return { ...row, metadata };
}
export function adminProfiles(vault, owner) {
  guard(vault, owner);
  return vault.ctx.storage.sql.exec('SELECT metadata FROM admin_profiles ORDER BY rowid').toArray()
    .map(row => JSON.parse(row.metadata)).filter(row => row.kind === 'default' && row.active)
    .map(({ id, revision, email }) => ({ id, revision, email, passwordConfigured: true }));
}
export async function saveAdminProfile(vault, owner, input) {
  const override = input.action === 'admin-override';
  exactSba(input, ['action', 'id', 'password', ...(override ? ['profile'] : ['email'])]);
  requireSba(override || input.action === 'admin-profile'); connectionId(input.id); guard(vault, owner);
  requireSba(typeof input.password === 'string' && new TextEncoder().encode(input.password).length >= 12 && new TextEncoder().encode(input.password).length <= 72 && !/[\x00-\x1f\x7f]/.test(input.password));
  requireSba([/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9\s]/].every(pattern => pattern.test(input.password)));
  const parent = override ? active(vault, input.profile).metadata : null;
  requireSba(!parent || parent.kind === 'default');
  const email = parent?.email ?? input.email;
  requireSba(typeof email === 'string' && email === email.toLowerCase() && /^[a-z0-9][a-z0-9._%+\-]{0,63}@gmail\.com$/.test(email));
  const metadata = { id: input.id, revision: 1, provider: 'admin-bootstrap', target: email, email,
    kind: override ? 'override' : 'default', profileId: parent?.id ?? input.id, active: true,
    expiresAt: override ? Date.now() + 15 * 60 * 1000 : null };
  const sealed = await sealToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, metadata, input.password);
  return vault.ctx.storage.transactionSync(() => {
    guard(vault, owner); requireSba(!stored(vault, input.id));
    // Only expired, unselectable temporary overrides are collected. Accepted
    // tasks keep their own immutable encrypted copy in admin_task_secrets.
    vault.ctx.storage.sql.exec("DELETE FROM admin_profiles WHERE json_extract(metadata,'$.kind')='override' AND json_extract(metadata,'$.expiresAt')<=?", Date.now());
    requireSba(vault.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM admin_profiles').one().n < 256);
    if (override) active(vault, input.profile);
    else requireSba(!adminProfiles(vault, owner).some(row => row.email === email));
    vault.ctx.storage.sql.exec('INSERT INTO admin_profiles VALUES(?,?,?)', input.id, JSON.stringify(metadata), sealed);
    return { profile: { id: input.id, revision: 1, email, passwordConfigured: true } };
  });
}
export function bootstrapConfiguration(vault, owner, input, declaration, configuration, credentials, previous) {
  if (!declaration.administrator) { requireSba(!input.administrator); return; }
  const { emailPath, secret } = declaration.administrator;
  credentials[secret] = 'bootstrap-disabled';
  if (input.instance) {
    requireSba(!input.administrator);
    const email = deploymentValue(previous, emailPath);
    if (email !== undefined) setDeploymentValue(configuration, emailPath, email);
    return;
  }
  if (!input.administrator) return;
  guard(vault, owner); const { profile, override } = input.administrator;
  const parent = active(vault, profile).metadata; requireSba(parent.kind === 'default');
  const selected = override ? active(vault, override).metadata : parent;
  requireSba(selected.profileId === parent.id && selected.email === parent.email);
  setDeploymentValue(configuration, emailPath, parent.email);
  credentials[secret] = 'bootstrap:' + selected.id;
}
export function reserveBootstrap(vault, owner, taskId, plan) {
  guard(vault, owner);
  for (const value of Object.values(plan.credentials ?? {})) if (value.startsWith('bootstrap:')) {
    const id = value.slice('bootstrap:'.length), row = active(vault, { id, revision: 1 });
    vault.ctx.storage.sql.exec('INSERT INTO admin_task_secrets VALUES(?,?,?,?)', taskId, value, JSON.stringify(row.metadata), row.sealed);
  }
}
export async function bootstrapCredential(vault, owner, record, key) {
  requireSba(Object.values(record.credentials ?? {}).includes(key));
  // Manifest secret sets are stable across actions; application updates and
  // copied-data previews never receive or consume an administrator password.
  if (key === 'bootstrap-disabled' || record.service.action !== 'deploy') return 'bootstrap-not-applicable';
  const row = vault.ctx.storage.sql.exec('SELECT metadata,sealed FROM admin_task_secrets WHERE task=? AND name=?', record.taskId, key).toArray()[0]; requireSba(row);
  return openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, JSON.parse(row.metadata), row.sealed);
}
