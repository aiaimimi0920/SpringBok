import { readJson, verifyConnection } from './connections-provider.mjs';
import { connectionId, connectionInput, connectionMetadata } from './connections-contract.mjs';
import { connectionDigest, sealToken, openToken } from './connections-crypto.mjs';
import { discoverResources } from './resources.mjs';

const requireValue = value => { if (!value) throw new Error('brand resource rejected'); };
const exact = (value, keys) => requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys.sort().join());
const login = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
const repository = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export const accountGithub = row => row.provider === 'github' && /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(row.target);

export async function brandAccounts(provider, token, accountId = '', transport) {
  if (provider === 'github') {
    const user = await readJson('https://api.github.com/user', token, true, transport);
    requireValue(Number.isSafeInteger(user.id) && user.id > 0 && login(user.login));
    return [{ target: '@' + user.login, label: user.login, check: 'github-account-read' }];
  }
  requireValue(provider === 'cloudflare');
  if (accountId) {
    requireValue(/^[a-f0-9]{32}$/.test(accountId));
    const body = await readJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, token, false, transport);
    requireValue(body.success === true && body.result?.id === accountId);
    return [{ target: accountId, label: label(body.result.name) ? body.result.name : accountId, check: 'account-read' }];
  }
  const accounts = [];
  for (let page = 1; page <= 4; page++) {
    const body = await readJson(`https://api.cloudflare.com/client/v4/accounts?per_page=10&page=${page}`, token, false, transport);
    requireValue(body.success === true && Array.isArray(body.result) && body.result.length <= 10);
    for (const row of body.result) { requireValue(/^[a-f0-9]{32}$/.test(row.id) && label(row.name)); accounts.push({ target: row.id, label: row.name, check: 'account-read' }); }
    requireValue(accounts.length <= 32 && new Set(accounts.map(row => row.target)).size === accounts.length);
    if (body.result.length < 10) { requireValue(accounts.length > 0); return accounts; }
  }
  throw new Error('account capacity');
}

// Brand enrollment reuses existing encrypted rows. A multi-account key is committed atomically.
export async function connectBrand(vault, owner, raw) {
  exact(raw, ['action','id','name','provider','token','accountId']);
  requireValue(raw.action === 'connect' && ['cloudflare','github'].includes(raw.provider) && typeof raw.accountId === 'string');
  requireValue(raw.provider === 'cloudflare' ? raw.accountId === '' || /^[a-f0-9]{32}$/.test(raw.accountId) : raw.accountId === '');
  const input = connectionInput({ action:'create', id:raw.id, name:raw.name, provider:raw.provider, target:raw.provider === 'cloudflare' ? 'a'.repeat(32) : 'owner/repository', token:raw.token });
  vault.ctx.storage.transactionSync(() => vault.guard(owner));
  const digest = await connectionDigest({ ...raw, name:input.name });
  const enrolled = () => vault.ctx.storage.sql.exec('SELECT metadata,digest FROM connections').toArray().filter(row => JSON.parse(row.metadata).enrollmentId === raw.id);
  const existing = vault.row(raw.id);
  if (existing) { requireValue(existing.digest === digest); return { connections:enrolled().map(row => connectionMetadata(JSON.parse(row.metadata))) }; }
  const accounts = await brandAccounts(raw.provider, raw.token, raw.accountId), time = Date.now();
  const entries = await Promise.all(accounts.map(async (account, index) => {
    const metadata = { id:index === 0 ? raw.id : crypto.randomUUID(), name:input.name, provider:raw.provider, target:account.target, accountName:account.label, enrollmentId:raw.id,
      revision:1, state:'verified', check:account.check, checkedAt:time, createdAt:time, updatedAt:time };
    return { metadata, sealed:await sealToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, metadata, raw.token) };
  }));
  return vault.ctx.storage.transactionSync(() => {
    vault.guard(owner); const race = vault.row(raw.id);
    if (race) { requireValue(race.digest === digest); return { connections:enrolled().map(row => connectionMetadata(JSON.parse(row.metadata))) }; }
    requireValue(vault.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM connections').one().n + entries.length <= 32);
    for (const {metadata,sealed} of entries) vault.ctx.storage.sql.exec('INSERT INTO connections VALUES(?,?,?,?)',metadata.id,JSON.stringify(metadata),sealed,digest);
    return { connections:entries.map(row => connectionMetadata(row.metadata)) };
  });
}

export async function inventory(vault, owner, input) {
  exact(input,['action','connectionId','kind','cursor']);requireValue(input.action === 'inventory');connectionId(input.connectionId);
  requireValue(['d1','kv','r2','worker','repository','zone'].includes(input.kind) && typeof input.cursor === 'string' && input.cursor.length <= 512);
  vault.ctx.storage.transactionSync(() => vault.guard(owner));
  const {row,sealed} = vault.activeConnection(input.connectionId), token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY,owner,row,sealed);
  let result;
  if (row.provider === 'cloudflare') {
    requireValue(input.kind !== 'repository');
    if (input.kind === 'worker') {
      requireValue(input.cursor === '');
      const body = await readJson(`https://api.cloudflare.com/client/v4/accounts/${row.target}/workers/scripts`,token,false);
      requireValue(body.success === true && Array.isArray(body.result) && body.result.length <= 1000);
      result = { items:body.result.map(item => { requireValue(typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,63}$/.test(item.id)); return {id:item.id,name:item.id}; }), next:null };
    } else {
      requireValue(input.kind === 'r2' ? input.cursor === '' || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.cursor) : /^(?:|[1-9][0-9]{0,4})$/.test(input.cursor));
      result = await discoverResources(row.target,token,input.kind,input.cursor);
    }
  } else {
    requireValue(row.provider === 'github' && input.kind === 'repository' && /^(?:|[1-9][0-9]{0,4})$/.test(input.cursor));
    const account = accountGithub(row), page = Number(input.cursor || '1');
    requireValue(account || input.cursor === '');
    const body = await readJson(account ? `https://api.github.com/user/repos?per_page=20&page=${page}&sort=full_name&direction=asc` : `https://api.github.com/repos/${row.target}`,token,true);
    const values = account ? body : [body];requireValue(Array.isArray(values) && values.length <= 20);
    const items = values.map(item => {
      requireValue(typeof item.full_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(item.full_name) && Number.isSafeInteger(item.id) && item.id > 0);
      return {id:item.full_name,name:item.full_name,available:repository(item.full_name) && item.archived !== true && item.disabled !== true,
        ...(!repository(item.full_name) ? {reason:'unsupported-name'} : {})};
    });
    result = { items, next:account && items.length === 20 ? String(page + 1) : null };
  }
  vault.activeConnection(row.id,row.revision);
  return {...result,connectionId:row.id,connectionRevision:row.revision,kind:input.kind,checkedAt:Date.now()};
}

// Only explicit repository selection creates a legacy-compatible deployment connection.
export async function useRepository(vault, owner, input) {
  exact(input,['action','id','revision','repository']);requireValue(input.action === 'use-repository' && repository(input.repository));connectionId(input.id);
  requireValue(Number.isSafeInteger(input.revision) && input.revision > 0);
  vault.ctx.storage.transactionSync(() => vault.guard(owner));
  const {row:parent,sealed} = vault.activeConnection(input.id,input.revision);requireValue(accountGithub(parent));
  const token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY,owner,parent,sealed);
  const check = await verifyConnection({provider:'github',target:input.repository},token);requireValue(check.ok);
  const time = Date.now(), metadata = {id:crypto.randomUUID(),name:parent.name,provider:'github',target:input.repository,parentId:parent.id,parentRevision:parent.revision,
    revision:1,state:'verified',check:check.code,checkedAt:time,createdAt:time,updatedAt:time};
  const encrypted = await sealToken(vault.env.CONNECTIONS_ENCRYPTION_KEY,owner,metadata,token), digest = await connectionDigest({parentId:parent.id,parentRevision:parent.revision,repository:input.repository});
  return vault.ctx.storage.transactionSync(() => {
    vault.activeConnection(parent.id,parent.revision);
    const existing = vault.ctx.storage.sql.exec('SELECT metadata FROM connections').toArray().map(row => JSON.parse(row.metadata)).find(row => row.parentId === parent.id && row.parentRevision === parent.revision && row.target === input.repository && row.state === 'verified');
    if (existing) return {connection:connectionMetadata(existing)};
    requireValue(vault.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM connections').one().n < 32);
    vault.ctx.storage.sql.exec('INSERT INTO connections VALUES(?,?,?,?)',metadata.id,JSON.stringify(metadata),encrypted,digest);
    return {connection:connectionMetadata(metadata)};
  });
}
