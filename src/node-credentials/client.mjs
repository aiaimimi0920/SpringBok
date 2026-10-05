import { nodeCredential, verifyIdentity } from '../../cloud/credential-contract.mjs';
import { readPrivateNodeJson } from './files.mjs';

export async function readCredentialResponse(response) {
  if (response.status !== 200) { await response.body?.cancel(); throw new Error('node response denied or unconfirmed'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) throw new Error('large node response'); chunks.push(value); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}
export function openCredentialClient({ file, expectedOrigin, fetcher = fetch }) {
  const credential = nodeCredential(readPrivateNodeJson(file), expectedOrigin);
  return Object.freeze({ async inspect() {
    const response = await fetcher(`${expectedOrigin}/node/v2/identity/${credential.role}/${credential.ownerId}/${credential.nodeId}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2 }) });
    return verifyIdentity(await readCredentialResponse(response), credential);
  } });
}
