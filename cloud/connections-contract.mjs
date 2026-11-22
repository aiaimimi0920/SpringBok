const fail = () => { throw new Error('invalid connection'); };
const hexKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keyId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
export function vaultKeyring(value) {
  if (hexKey(value)) return { legacy: true, active: null, keys: { '': value } };
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('{')) return null;
  let parsed; try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'active,keys') return null;
  const { active, keys } = parsed;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return null;
  const entries = Object.entries(keys);
  if (entries.length < 1 || entries.length > 8 || !entries.every(([k, v]) => keyId(k) && hexKey(v))) return null;
  if (!Object.hasOwn(keys, active) || new Set(entries.map(([, v]) => v)).size !== entries.length) return null;
  return { legacy: false, active, keys: Object.fromEntries(entries) };
}
export const validVaultKey = value => vaultKeyring(value) !== null;
export function ownerId(value) { if (!hexKey(value)) fail(); return value; }
export function connectionId(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail(); return value; }
const validCredentialToken = value => typeof value === 'string' && /^[A-Za-z0-9_.=-]{20,512}$/.test(value);
export function connectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const keys = input.action === 'create' ? ['action', 'id', 'name', 'provider', 'target', 'token'] :
    input.action === 'rotate' ? ['action', 'id', 'revision', 'token'] : ['action', 'id', 'revision'];
  if (Object.keys(input).sort().join(',') !== keys.sort().join(',')) fail();
  connectionId(input.id);
  if (input.action === 'rotate') {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !validCredentialToken(input.token)) fail();
    return { action: 'rotate', id: input.id, revision: input.revision, token: input.token };
  }
  if (input.action !== 'create') {
    if (!['verify', 'disable'].includes(input.action) || !Number.isSafeInteger(input.revision) || input.revision < 1) fail();
    return { action: input.action, id: input.id, revision: input.revision };
  }
  if (typeof input.name !== 'string' || typeof input.target !== 'string' || !validCredentialToken(input.token)) fail();
  const name = input.name.normalize('NFC').trim(), target = input.target.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) fail();
  if (input.provider === 'cloudflare') { if (!/^[a-f0-9]{32}$/.test(target)) fail(); }
  else if (input.provider === 'github') {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(target)) fail();
  } else fail();
  return { action: 'create', id: input.id, name, provider: input.provider, target, token: input.token };
}
export const connectionMetadata = row => ({ id: row.id, name: row.name, provider: row.provider, target: row.target,
  revision: row.revision, state: row.state, check: row.check, checkedAt: row.checkedAt,
  createdAt: row.createdAt, updatedAt: row.updatedAt, deploymentPermissionsVerified: false,
  ...(row.accountName ? {accountName:row.accountName} : {}), ...(row.parentId ? {parentId:row.parentId,parentRevision:row.parentRevision} : {}) });
