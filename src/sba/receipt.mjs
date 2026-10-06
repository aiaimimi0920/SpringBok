import { validateResult } from './contract.mjs';
const reject = () => { throw new Error('SBA_RECEIPT_REJECTED'); };
const decoder = new TextDecoder('utf-8', { fatal: true });
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// 只接受本平台唯一文件 receipt.json；不是通用 ZIP 解包器，不写磁盘。
export async function readSbaReceipt(archive, expected) {
  try {
    if (!(archive instanceof Uint8Array) || archive.length < 22 || archive.length > 65536 ||
        typeof expected?.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expected.digest)) reject();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', archive))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (`sha256:${hash}` !== expected.digest) reject();
    const v = new DataView(archive.buffer, archive.byteOffset, archive.byteLength), end = archive.length - 22;
    const u16 = offset => v.getUint16(offset, true), u32 = offset => v.getUint32(offset, true);
    if (u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== 1 ||
        u16(end + 10) !== 1 || u16(end + 20)) reject();
    const central = u32(end + 16), centralSize = u32(end + 12);
    if (central + centralSize !== end || centralSize < 46 || u32(central) !== 0x02014b50) reject();
    const flags = u16(central + 8), method = u16(central + 10), crc = u32(central + 16),
      packed = u32(central + 20), unpacked = u32(central + 24), nameLength = u16(central + 28);
    // UTF-8 和 data descriptor 是唯一允许的标志；拒绝加密、ZIP64、多卷、附加字段和注释。
    if ((flags & ~0x0808) !== 0 || ![0, 8].includes(method) || unpacked < 1 || unpacked > 32768 ||
        packed < 1 || packed > 65536 || u16(central + 30) || u16(central + 32) || u16(central + 34) ||
        u32(central + 42) !== 0 || centralSize !== 46 + nameLength || u16(central + 6) > 20) reject();
    const mode = u32(central + 38) >>> 16;
    if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) reject();
    const name = decoder.decode(archive.subarray(central + 46, central + 46 + nameLength));
    if (name !== 'receipt.json' || u32(0) !== 0x04034b50 || u16(4) > 20 || u16(6) !== flags ||
        u16(8) !== method || u16(26) !== nameLength || u16(28) !== 0 ||
        decoder.decode(archive.subarray(30, 30 + nameLength)) !== name) reject();
    const start = 30 + nameLength, dataEnd = start + packed;
    if (dataEnd > central) reject();
    if (flags & 8) {
      const signed = central - dataEnd === 16;
      if (central - dataEnd !== 12 && !signed) reject();
      if (signed && u32(dataEnd) !== 0x08074b50) reject();
      const descriptor = dataEnd + (signed ? 4 : 0);
      if (u32(descriptor) !== crc || u32(descriptor + 4) !== packed || u32(descriptor + 8) !== unpacked ||
          ![0, crc].includes(u32(14)) || ![0, packed].includes(u32(18)) || ![0, unpacked].includes(u32(22))) reject();
    } else if (dataEnd !== central || u32(14) !== crc || u32(18) !== packed || u32(22) !== unpacked) reject();
    let bytes = archive.subarray(start, dataEnd);
    if (method === 8) {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > unpacked || size > 32768) reject(); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }
    if (bytes.length !== unpacked || crc32(bytes) !== crc) reject();
    const envelope = JSON.parse(decoder.decode(bytes));
    if (!exact(envelope, ['schemaVersion', 'runId', 'runAttempt', 'executorSha', 'requestDigest', 'permitId', 'result']) ||
        envelope.schemaVersion !== 1 || envelope.runAttempt !== 1 || !Number.isSafeInteger(envelope.runId) || envelope.runId < 1 ||
        !/^[a-f0-9]{40}$/.test(envelope.executorSha) || !/^[a-f0-9]{64}$/.test(envelope.requestDigest) ||
        !/^[a-f0-9]{64}$/.test(envelope.permitId)) reject();
    for (const key of ['runId', 'executorSha', 'requestDigest', 'permitId']) if (envelope[key] !== expected[key]) reject();
    validateResult(envelope.result, expected.request);
    return envelope;
  } catch { reject(); }
}
