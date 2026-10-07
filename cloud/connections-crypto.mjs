import { validVaultKey } from './connections-contract.mjs';
const bytes = new TextEncoder();
const hex = value => [...value].map(x => x.toString(16).padStart(2, '0')).join('');
function unhex(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error('invalid envelope');
  return Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
}
async function key(value) {
  if (!validVaultKey(value)) throw new Error('vault unavailable');
  return crypto.subtle.importKey('raw', unhex(value), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const aad = (owner, row) => bytes.encode(JSON.stringify(['springbok-connection-v1', owner, row.id, row.provider, row.target]));
export async function sealToken(secret, owner, row, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner, row) }, await key(secret), bytes.encode(token));
  return JSON.stringify({ version: 1, iv: hex(iv), cipher: hex(new Uint8Array(cipher)) });
}
export async function openToken(secret, owner, row, sealed) {
  const envelope = JSON.parse(sealed);
  if (envelope.version !== 1 || envelope.iv?.length !== 24 || typeof envelope.cipher !== 'string' || envelope.cipher.length > 1100) throw new Error('invalid envelope');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(envelope.iv), additionalData: aad(owner, row) }, await key(secret), unhex(envelope.cipher));
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}
export async function connectionDigest(input) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.encode(JSON.stringify(input)))));
}
