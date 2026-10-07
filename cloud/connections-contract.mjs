const fail = () => { throw new Error('invalid connection'); };
export const validVaultKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function ownerId(value) { if (!validVaultKey(value)) fail(); return value; }
export function connectionId(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail(); return value; }
export function connectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const keys = input.action === 'create' ? ['action', 'id', 'name', 'provider', 'target', 'token'] : ['action', 'id', 'revision'];
  if (Object.keys(input).sort().join(',') !== keys.sort().join(',')) fail();
  connectionId(input.id);
  if (input.action !== 'create') {
    if (!['verify', 'disable'].includes(input.action) || !Number.isSafeInteger(input.revision) || input.revision < 1) fail();
    return { action: input.action, id: input.id, revision: input.revision };
  }
  if (typeof input.name !== 'string' || typeof input.target !== 'string' || typeof input.token !== 'string') fail();
  const name = input.name.normalize('NFC').trim(), target = input.target.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name) || !/^[A-Za-z0-9_.=-]{20,512}$/.test(input.token)) fail();
  if (input.provider === 'cloudflare') { if (!/^[a-f0-9]{32}$/.test(target)) fail(); }
  else if (input.provider === 'github') {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(target)) fail();
  } else fail();
  return { action: 'create', id: input.id, name, provider: input.provider, target, token: input.token };
}
export const connectionMetadata = row => ({ id: row.id, name: row.name, provider: row.provider, target: row.target,
  revision: row.revision, state: row.state, check: row.check, checkedAt: row.checkedAt,
  createdAt: row.createdAt, updatedAt: row.updatedAt, deploymentPermissionsVerified: false });
