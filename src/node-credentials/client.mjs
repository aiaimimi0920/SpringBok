import { nodeCredential, verifyIdentity } from '../../cloud/credential-contract.mjs';
import { readPrivateNodeJson } from './files.mjs';

export class RetryableNodeError extends Error {
  constructor() { super('node transport temporarily unavailable'); this.name = 'RetryableNodeError'; }
}
const NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
function transportError(error) {
  if (error instanceof RetryableNodeError || ['TimeoutError', 'AbortError'].includes(error?.name) || NETWORK_ERRORS.has(error?.code) || NETWORK_ERRORS.has(error?.cause?.code)) return new RetryableNodeError();
  return error; // 未识别错误（含 TLS/redirect/程序错误）失败关闭，不按网络故障无限重试。
}
export async function readCredentialResponse(response) {
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if ([429, 500, 502, 503, 504].includes(response.status)) throw new RetryableNodeError();
    throw new Error('node response denied or unconfirmed');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      let chunk; try { chunk = await reader.read(); } catch (error) { throw transportError(error); }
      const { done, value } = chunk; if (done) break;
      size += value.length; if (size > 4096) throw new Error('large node response'); chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}
export async function fetchCredentialJson(fetcher, url, init) {
  let response; try { response = await fetcher(url, init); } catch (error) { throw transportError(error); }
  return readCredentialResponse(response);
}
export function openCredentialClient({ file, expectedOrigin, fetcher = fetch }) {
  const credential = nodeCredential(readPrivateNodeJson(file), expectedOrigin);
  return Object.freeze({ async inspect() {
    const result = await fetchCredentialJson(fetcher, `${expectedOrigin}/node/v2/identity/${credential.role}/${credential.ownerId}/${credential.nodeId}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 2 }) });
    return verifyIdentity(result, credential);
  } });
}
