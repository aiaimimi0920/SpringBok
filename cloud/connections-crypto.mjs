import { vaultKeyring } from './connections-contract.mjs';
const bytes = new TextEncoder();
const hex = value => [...value].map(x => x.toString(16).padStart(2, '0')).join('');
function unhex(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error('invalid envelope');
  return Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
}
async function importRaw(rawHex) {
  return crypto.subtle.importKey('raw', unhex(rawHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function ring(secret) {
  const parsed = vaultKeyring(secret);
  if (!parsed) throw new Error('vault unavailable');
  return parsed;
}
const aadV1 = (owner, row) => bytes.encode(JSON.stringify(['springbok-connection-v1', owner, row.id, row.provider, row.target]));
const aadV2 = (keyId, owner, row) => bytes.encode(JSON.stringify(['springbok-connection-v2', keyId, owner, row.id, row.provider, row.target]));
export async function sealToken(secret, owner, row, token) {
  const keyring = ring(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  if (keyring.legacy) {
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadV1(owner, row) }, await importRaw(keyring.keys['']), bytes.encode(token));
    return JSON.stringify({ version: 1, iv: hex(iv), cipher: hex(new Uint8Array(cipher)) });
  }
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadV2(keyring.active, owner, row) }, await importRaw(keyring.keys[keyring.active]), bytes.encode(token));
  return JSON.stringify({ version: 2, keyId: keyring.active, iv: hex(iv), cipher: hex(new Uint8Array(cipher)) });
}
export async function openToken(secret, owner, row, sealed) {
  const keyring = ring(secret);
  const envelope = JSON.parse(sealed);
  if (![1, 2].includes(envelope.version) || envelope.iv?.length !== 24 || typeof envelope.cipher !== 'string' || envelope.cipher.length < 34 || envelope.cipher.length > 34000) throw new Error('invalid envelope');
  const iv = unhex(envelope.iv), ciphertext = unhex(envelope.cipher);
  if (envelope.version === 2) {
    if (keyring.legacy || typeof envelope.keyId !== 'string' || !Object.hasOwn(keyring.keys, envelope.keyId)) throw new Error('invalid envelope');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadV2(envelope.keyId, owner, row) }, await importRaw(keyring.keys[envelope.keyId]), ciphertext);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  }
  for (const rawHex of Object.values(keyring.keys)) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadV1(owner, row) }, await importRaw(rawHex), ciphertext);
      return new TextDecoder('utf-8', { fatal: true }).decode(plain);
    } catch { /* Try next ring key for pre-rotation v1 envelope; fail closed if none authenticate. */ }
  }
  throw new Error('invalid envelope');
}
export async function connectionDigest(input) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.encode(JSON.stringify(input)))));
}
