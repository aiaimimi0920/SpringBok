import { deflateRawSync } from 'node:zlib';
export function zip(value, { method = 8, descriptor = false, name = 'receipt.json', raw } = {}) {
  const bytes = Buffer.from(raw ?? JSON.stringify(value)), packed = method === 8 ? deflateRawSync(bytes) : bytes, filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), tail = Buffer.alloc(descriptor ? 16 : 0);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(method, 8); local.writeUInt16LE(filename.length, 26);
  if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); }
  else { tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(crc, 4); tail.writeUInt32LE(packed.length, 8); tail.writeUInt32LE(bytes.length, 12); }
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(descriptor ? 8 : 0, 8);
  central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length + tail.length, 16);
  return Buffer.concat([local, filename, packed, tail, central, filename, end]);
}
