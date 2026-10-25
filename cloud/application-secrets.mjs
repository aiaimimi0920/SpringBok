import { connectionId } from './connections-contract.mjs';
import { exactSba, requireSba, canonicalSba } from './sba-control.mjs';
import { sealToken, openToken } from './connections-crypto.mjs';
import { suiteRepository } from './deployment-suite.mjs';
import { connectionReference } from './deployment-contract.mjs';

const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(value);
function guard(vault, owner) {
  vault.guard(owner);
  const sql = vault.ctx.storage.sql;
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('application_secret_meta','application_secrets','application_task_secrets')").toArray();
  if (!tables.length) {
    sql.exec('CREATE TABLE application_secret_meta (version INTEGER PRIMARY KEY CHECK(version=1))');
    sql.exec('INSERT INTO application_secret_meta VALUES(1)');
    sql.exec('CREATE TABLE application_secrets (id TEXT PRIMARY KEY,metadata TEXT NOT NULL,sealed TEXT NOT NULL)');
    sql.exec('CREATE TABLE application_task_secrets (task TEXT NOT NULL,name TEXT NOT NULL,metadata TEXT NOT NULL,sealed TEXT NOT NULL,PRIMARY KEY(task,name))');
  } else {
    const versions = sql.exec('SELECT version FROM application_secret_meta').toArray();
    requireSba(tables.length === 3 && versions.length === 1 && versions[0].version === 1);
  }
}
const stored = (vault, id) => vault.ctx.storage.sql.exec('SELECT * FROM application_secrets WHERE id=?', id).toArray()[0];
function active(vault, reference) {
  connectionReference(reference);
  const row = stored(vault, reference.id); requireSba(row);
  const metadata = JSON.parse(row.metadata);
  requireSba(metadata.active && metadata.revision === reference.revision);
  return { metadata, sealed: JSON.parse(row.sealed) };
}
const metadataFor = (profile, name) => ({ id: profile.id + ':' + name, provider: 'application-secret', target: profile.repository + '/' + profile.applicationId + '/' + name });
export function applicationSecretProfiles(vault, owner) {
  guard(vault, owner);
  return vault.ctx.storage.sql.exec('SELECT metadata FROM application_secrets ORDER BY rowid').toArray().map(row => JSON.parse(row.metadata)).filter(row => row.active);
}
export async function saveApplicationSecrets(vault, owner, input) {
  const disable = input.action === 'disable-application-secrets';
  exactSba(input, disable ? ['action','id','revision'] : ['action','id','repository','applicationId','values']);
  connectionId(input.id); guard(vault, owner);
  if (disable) return vault.ctx.storage.transactionSync(() => {
    const { metadata } = active(vault, { id: input.id, revision: input.revision }), next = { ...metadata, active: false, revision: metadata.revision + 1 };
    vault.ctx.storage.sql.exec('UPDATE application_secrets SET metadata=? WHERE id=?', JSON.stringify(next), input.id);
    return { profile: next };
  });
  requireSba(input.action === 'application-secrets' && suiteRepository(input.repository) && identifier(input.applicationId));
  requireSba(input.values && typeof input.values === 'object' && !Array.isArray(input.values));
  const names = Object.keys(input.values).sort();
  requireSba(names.length > 0 && names.length <= 20 && names.every(name => /^[A-Z][A-Z0-9_]{1,63}$/.test(name)));
  const profile = { id: input.id, revision: 1, repository: input.repository.toLowerCase(), applicationId: input.applicationId, names, active: true, createdAt: Date.now() }, sealed = {};
  for (const name of names) {
    const value = input.values[name], bytes = typeof value === 'string' ? new TextEncoder().encode(value).length : 0;
    requireSba(bytes > 0 && bytes <= 512 && !/[\x00-\x1f\x7f]/.test(value));
    sealed[name] = await sealToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, metadataFor(profile,name), value);
  }
  return vault.ctx.storage.transactionSync(() => {
    guard(vault, owner); requireSba(!stored(vault, input.id) && vault.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM application_secrets').one().n < 128);
    vault.ctx.storage.sql.exec('INSERT INTO application_secrets VALUES(?,?,?)', input.id, JSON.stringify(profile), JSON.stringify(sealed));
    return { profile };
  });
}
export function configureApplicationSecrets(vault, owner, input, application, credentials, previous = null) {
  const names = application.declaration.applicationSecrets ?? [];
  if (!names.length) { requireSba(!input.applicationSecrets); return null; }
  guard(vault, owner);
  if (input.instance) requireSba(!input.applicationSecrets);
  const reference = input.instance ? previous?.applicationSecrets : input.applicationSecrets;
  const { metadata } = active(vault, reference);
  requireSba(metadata.repository === application.repository.toLowerCase() && metadata.applicationId === application.manifest.id && canonicalSba(metadata.names) === canonicalSba([...names].sort()));
  for (const name of names) credentials[name] = 'application:' + name;
  return { id: metadata.id, revision: metadata.revision };
}
export function reserveApplicationSecrets(vault, owner, taskId, plan) {
  if (!plan.applicationSecrets) return;
  guard(vault, owner);
  const { metadata, sealed } = active(vault, plan.applicationSecrets);
  requireSba(metadata.repository === plan.application.repository.toLowerCase() && metadata.applicationId === plan.application.manifest.id);
  for (const name of plan.application.declaration.applicationSecrets) {
    if(plan.operation?.action==='repair'&&plan.credentials[name]==='repair-disabled')continue;
    requireSba(plan.credentials[name] === 'application:' + name && typeof sealed[name] === 'string');
    vault.ctx.storage.sql.exec('INSERT INTO application_task_secrets VALUES(?,?,?,?)', taskId, name, JSON.stringify(metadataFor(metadata,name)), sealed[name]);
  }
}
export async function applicationCredential(vault, owner, record, mapping) {
  requireSba(Object.values(record.credentials ?? {}).includes(mapping) && /^application:[A-Z][A-Z0-9_]{1,63}$/.test(mapping));
  guard(vault, owner);
  const name = mapping.slice('application:'.length);
  const row = vault.ctx.storage.sql.exec('SELECT metadata,sealed FROM application_task_secrets WHERE task=? AND name=?', record.taskId, name).toArray()[0]; requireSba(row);
  const metadata = JSON.parse(row.metadata);
  requireSba(metadata.target === record.service.application.repository.toLowerCase() + '/' + record.service.application.id + '/' + name);
  return openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, metadata, row.sealed);
}
