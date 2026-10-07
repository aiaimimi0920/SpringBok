import { sourceDiagnostic } from './diagnostics.mjs';
// 受控源码传输：只请求批准 SHA 的 depth=1 pack，不向 runner 暴露 GitHub token。
export const SOURCE_CONTENT_TYPE = 'application/x-git-upload-pack-result';
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const reject = () => { throw new Error('SBA_SOURCE_REJECTED'); };
const shaPattern = /^[a-f0-9]{40}$/;
const encoder = new TextEncoder();
const ascii = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const pkt = text => (encoder.encode(text).length + 4).toString(16).padStart(4, '0') + text;
export function sourceWant(sha) {
  if (typeof sha !== 'string' || !shaPattern.test(sha)) reject();
  return pkt(`want ${sha} side-band-64k ofs-delta no-progress\n`) + pkt('deepen 1\n') + '0000' + pkt('done\n');
}

// 请求和响应都不自动重试，不接受 redirect 或任意上游日志。
export async function requestSource(url, { headers, body, fetchImpl = fetch, onFailure = () => {} }) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  let response, reason = 'network';
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
    reason = 'http'; if (response.status !== 200) reject();
    reason = 'media'; if (response.headers.get('content-type')?.split(';')[0] !== SOURCE_CONTENT_TYPE) reject();
    reason = 'body-missing'; if (!response.body) reject();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        reason = 'body-read'; const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; reason = 'body-size'; if (size > MAX_SOURCE_BYTES) reject(); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    reason = 'body-empty'; if (!size) reject();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch { onFailure(sourceDiagnostic(response, reason)); reject(); }
  finally { clearTimeout(timer); controller.abort(); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}

export function githubSourcePack(repository, sha, token, { fetchImpl = fetch, onFailure = () => {} } = {}) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) ||
      typeof token !== 'string' || !token || /[^\x21-\x7e]/.test(token)) reject();
  return requestSource(`https://github.com/${repository}.git/git-upload-pack`, {
    headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}`, 'content-type': 'application/x-git-upload-pack-request',
      accept: SOURCE_CONTENT_TYPE, 'user-agent': 'SpringBok-SBA' }, body: sourceWant(sha), fetchImpl, onFailure,
  });
}

// 严格解析固定请求的 v0 shallow/NAK/sideband 响应；错误/进度原文不进入日志。
export async function decodeSourceResponse(bytes, sha) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SOURCE_BYTES || !shaPattern.test(sha)) reject();
    let offset = 0;
    const packet = () => {
      if (offset + 4 > bytes.length) reject();
      const header = ascii(bytes.subarray(offset, offset + 4)); offset += 4;
      if (!/^[0-9a-f]{4}$/.test(header)) reject();
      const size = Number.parseInt(header, 16);
      if (size === 0) return null;
      if (size < 5 || size > 65520 || offset + size - 4 > bytes.length) reject();
      const payload = bytes.subarray(offset, offset + size - 4); offset += size - 4; return payload;
    };
    if (![ `shallow ${sha}`, `shallow ${sha}\n` ].includes(ascii(packet())) || packet() !== null || ascii(packet()) !== 'NAK\n') reject();
    const chunks = []; let size = 0;
    for (;;) {
      const part = packet(); if (part === null) break;
      if (part.length < 2 || part[0] !== 1) reject();
      const data = part.subarray(1); chunks.push(data); size += data.length;
    }
    if (offset !== bytes.length || size < 32) reject();
    let pack = new Uint8Array(size); offset = 0;
    for (const chunk of chunks) { pack.set(chunk, offset); offset += chunk.length; }
    if (ascii(pack.subarray(0, 4)) !== 'PACK') reject();
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    if (![2, 3].includes(view.getUint32(4)) || view.getUint32(8) < 1 || view.getUint32(8) > 20000) reject();
    const checksum = async p => {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', p.subarray(0, -20)));
      return hash.every((value, index) => value === p[p.length - 20 + index]);
    };
    // GitHub upload-pack 在 pack 校验和后可发送一个换行；不允许其他尾随内容。
    if (!await checksum(pack)) {
      if (pack.at(-1) !== 10 || !await checksum(pack.subarray(0, -1))) reject();
      pack = pack.subarray(0, -1);
    }
    return { pack, shallow: sha };
  } catch { reject(); }
}
