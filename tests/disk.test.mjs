import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { collectDisk, diskCapacity, isDiskSample, parseMountInfo, readMountInfo, selectDiskMounts,
  MAX_MOUNTINFO_BYTES, MAX_MOUNT_ENTRIES } from '../src/node-telemetry/disk.mjs';

const row = (id = 1, parent = 99, path = '/', fs = 'ext4', root = '/', options = 'rw', source = 'private-source') =>
  `${id} ${parent} 8:1 ${root} ${path} ${options} shared:9 unknown:future - ${fs} ${source} rw,private-secret\n`;
const stats = overrides => ({ type: 0xef53n, bsize: 4096n, blocks: 100n, bfree: 40n, bavail: 30n, ...overrides });
const sample = options => collectDisk({ readInfo: async () => row(), readStats: async () => stats(), verifyPath: async () => {}, wallClock: () => 1000, ...options });

test('disk mountinfo strictly decodes four kernel escapes, retains identities/options and omits secrets', () => {
  const entries = parseMountInfo(row() + row(2, 1, '/space\\040tab\\011newline\\012slash\\134tail', 'xfs', '/', 'ro'));
  assert.equal(entries[1].mountPoint, '/space tab\tnewline\nslash\\tail'); assert.equal(entries[1].readOnly, true);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['mountId', 'parentId', 'device', 'root', 'mountPoint', 'fsType', 'readOnly'].sort());
  assert.ok(!JSON.stringify(entries).includes('private')); assert.equal(selectDiskMounts(entries).mounts.length, 2);
  for (const text of ['', row().trimEnd(), row().replace('8:1', '08:1'), row().replace('1 99', '1 1'), row() + row(),
    row().replace('1 99', '9007199254740992 99'), row().replace('rw shared', 'ro,rw shared'), row().replace(' - ', ' '),
    row().replace(' - ', ' - - '), row().replace('shared:9', 'shared:\t9'), row(1, 99, '/bad\\041'), row(1, 99, '/a/../b'),
    row(1, 99, 'relative'), row(1, 99, '/a//b'), row(1, 99, '/a/'), row(1, 99, '/a\0b'), row(1, 99, '/' + 'a'.repeat(4096))]) {
    assert.throws(() => parseMountInfo(text), /Invalid/);
  }
  const exact = row().trimEnd().padEnd(MAX_MOUNTINFO_BYTES - 1, 'x') + '\n';
  assert.equal(parseMountInfo(exact).length, 1); assert.throws(() => parseMountInfo(exact + '\n'));
  const many = Array.from({ length: MAX_MOUNT_ENTRIES }, (_, i) => row(i + 1, 99999, `/m${i}`)).join('');
  assert.equal(parseMountInfo(many).length, MAX_MOUNT_ENTRIES); assert.throws(() => parseMountInfo(many + row(5000)));
});

test('disk filters pseudo, unsupported and subtree binds before touching paths; no aggregate is invented', async () => {
  const text = row() + row(2, 1, '/proc', 'proc') + row(3, 1, '/ram', 'tmpfs') + row(4, 1, '/net', 'nfs4') +
    row(5, 1, '/fuse', 'fuse.sshfs') + row(6, 1, '/hosts', 'ext4', '/etc/hosts') + row(7, 1, '/sub', 'btrfs', '/subvolume') + row(8, 1, '/unknown', 'future');
  const called = [], result = await sample({ readInfo: async () => text, verifyPath: async path => called.push(path) });
  assert.deepEqual(called, ['/']); assert.equal(result.status, 'available'); assert.equal(result.mounts.length, 1);
  assert.deepEqual(result.filtered, { pseudo: 2, unsupported: 3, subtree: 2, unsafeTopology: 0 });
  assert.equal(isDiskSample(result), true); assert.ok(!JSON.stringify(result).includes('private'));
});

test('disk fails closed on stacked/hidden mounts, unsafe path ancestors, parent cycles or missing namespace root', async () => {
  const cases = [
    row() + row(2, 1, '/stack') + row(3, 2, '/stack') + row(4, 2, '/stack/child'),
    row() + row(2, 1, '/hide', 'xfs') + row(3, 1, '/hide/child'),
    row() + row(2, 1, '/auto', 'autofs') + row(3, 2, '/auto/child'),
    row() + row(2, 1, '/net', 'nfs') + row(3, 2, '/net/child'),
    row() + row(2, 1, '/fuse', 'fuse') + row(3, 2, '/fuse/child'),
    row() + row(2, 3, '/a') + row(3, 2, '/a/b'),
  ];
  for (const text of cases) {
    const called = [], result = await sample({ readInfo: async () => text, verifyPath: async path => called.push(path) });
    assert.deepEqual(called, text.includes('/hide') ? ['/', '/hide'] : ['/']); assert.ok(result.filtered.unsafeTopology > 0);
  }
  for (const text of [row() + row(2, 1, '/'), row(2, 99, '/no-root'), row(1, 99, '/', 'nfs') + row(2, 1, '/local')]) {
    const result = await sample({ readInfo: async () => text, readStats: async () => assert.fail('unsafe statfs') });
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'no-supported-mounts'); assert.equal(isDiskSample(result), true);
  }
});

test('disk overlay is explicitly unsupported before statfs because its backing unit is unknown', async () => {
  const result = await sample({ readInfo: async () => row(1, 99, '/', 'overlay'),
    verifyPath: async () => assert.fail('do not query unknown backing'), readStats: async () => assert.fail('do not statfs overlay') });
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'no-supported-mounts');
  assert.equal(result.filtered.unsupported, 1); assert.deepEqual(result.mounts, []); assert.equal(isDiskSample(result), true);
});

test('disk selected-mount limit is all-or-nothing, not a silent truncation or extra statfs call', async () => {
  const text = row() + Array.from({ length: 32 }, (_, i) => row(i + 2, 1, `/d${i}`)).join('');
  const result = await sample({ readInfo: async () => text, verifyPath: async () => assert.fail('limit must precede path calls') });
  assert.equal(result.reason, 'mount-limit'); assert.equal(result.mounts.length, 0); assert.equal(result.sampledAt, null);
});

test('disk BigInt gauge distinguishes df used, user available, free/reserved difference and genuine zero', () => {
  assert.deepEqual(diskCapacity(stats(), 'ext4'), { totalBytes: 409600, freeBytes: 163840, availableBytes: 122880,
    usedBytes: 245760, reservedBytes: 40960, usagePercent: 66.67 });
  assert.equal(diskCapacity(stats({ bfree: 100n, bavail: 100n }), 'ext2').usagePercent, 0);
  assert.equal(diskCapacity(stats({ bfree: 0n, bavail: 0n }), 'ext3').usagePercent, 100);
  assert.equal(diskCapacity(stats({ bfree: 40n, bavail: 0n }), 'ext4').availableBytes, 0);
  assert.equal(diskCapacity(stats({ bsize: 1n, blocks: BigInt(Number.MAX_SAFE_INTEGER), bfree: 0n, bavail: 0n }), 'ext4').totalBytes, Number.MAX_SAFE_INTEGER);
  for (const [fs, type] of [['xfs', 0x58465342n], ['btrfs', 0x9123683en]]) assert.equal(diskCapacity(stats({ type }), fs).usagePercent, 66.67);
  for (const change of [{ type: 0n }, { bsize: 4096 }, { blocks: 100 }, { bavail: null }, { bsize: 0n }, { blocks: 0n },
    { bsize: -1n }, { bfree: -1n }, { bavail: -1n }, { bfree: 101n }, { bavail: 41n }, { bfree: 100n, bavail: 0n },
    { blocks: BigInt(Number.MAX_SAFE_INTEGER) }, { bsize: 1n, blocks: BigInt(Number.MAX_SAFE_INTEGER) + 1n }]) assert.throws(() => diskCapacity(stats(change), 'ext4'));
  assert.throws(() => diskCapacity(stats(), 'unknown')); assert.throws(() => diskCapacity(stats({ type: 0x794c7630n }), 'overlay'));
});

test('disk snapshots bind topology before/after and discard measurements on any changed or failed reread', async () => {
  for (const after of [row(1, 99, '/', 'ext4', '/', 'ro'), row().replace('8:1', '8:2'), row(1, 99, '/', 'ext4', '/changed'),
    row().replace('private-source', 'other-private-source'), row().replace('shared:9', 'shared:10')]) {
    let reads = 0; const result = await sample({ readInfo: async () => reads++ === 0 ? row() : after });
    assert.equal(result.reason, 'mounts-changed'); assert.equal(result.mounts.length, 0); assert.equal(isDiskSample(result), true);
  }
  let reads = 0; assert.equal((await sample({ readInfo: async () => { if (reads++ === 0) return row(); throw new Error('private-error'); } })).reason, 'read-failed');
  assert.equal((await sample({ readInfo: async () => { throw new Error('private-error'); } })).reason, 'read-failed');
  assert.equal((await sample({ readInfo: async () => 'private malformed\n' })).reason, 'invalid-mountinfo');
});

test('disk partial/unavailable mounts preserve identity but all failed values are null and errors stay redacted', async () => {
  const text = row() + row(2, 1, '/second');
  const result = await sample({ readInfo: async () => text, readStats: async path => { if (path === '/second') throw new Error('private-secret'); return stats(); } });
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'mount-unavailable'); assert.equal(isDiskSample(result), true);
  assert.equal(result.mounts[1].reason, 'statfs-failed'); assert.equal(result.mounts[1].usedBytes, null);
  assert.ok(!JSON.stringify(result).includes('private'));
  for (const [options, reason] of [[{ verifyPath: async () => { throw new Error('private'); } }, 'path-unavailable'],
    [{ readStats: async () => stats({ type: 0n }) }, 'invalid-statfs']]) {
    const failed = await sample(options); assert.equal(failed.status, 'unavailable'); assert.equal(failed.mounts[0].reason, reason); assert.equal(isDiskSample(failed), true);
  }
  for (const clock of [() => -1, () => NaN, () => 0.5, () => Number.MAX_SAFE_INTEGER, () => { throw new Error('private'); }]) assert.equal((await sample({ wallClock: clock })).reason, 'clock-unavailable');
  assert.equal((await sample({ wallClock: () => 0 })).sampledAt, '1970-01-01T00:00:00.000Z');
});

test('disk worker sample validation rejects extra secrets, corrupt identities/counts/formulas/status and null zero confusion', async () => {
  const valid = await sample(); assert.equal(isDiskSample(valid), true);
  for (const mutate of [v => { v.source = 'private'; }, v => { v.status = 'partial'; }, v => { v.reason = 'unknown'; },
    v => { v.sampledAt = 'yesterday'; }, v => { v.sampledAt = '1960-01-01T00:00:00.000Z'; }, v => { v.filtered.pseudo = -1; },
    v => { v.filtered.pseudo = 4096; }, v => { v.mounts[0].mountId = 0; }, v => { v.mounts[0].device = ['8:1']; },
    v => { v.mounts[0].mountPoint = '/a/../b'; }, v => { v.mounts[0].fsType = 'nfs'; }, v => { v.mounts[0].usedBytes = 286720; },
    v => { v.mounts[0].reservedBytes = 0; }, v => { v.mounts[0].usagePercent = 60; }, v => { v.mounts[0].totalBytes = null; },
    v => { v.mounts[0].status = 'unavailable'; }, v => { v.mounts.push(v.mounts[0]); }, v => { v.mounts.push({ ...v.mounts[0], mountId: 2 }); }]) {
    const changed = structuredClone(valid); mutate(changed); assert.equal(isDiskSample(changed), false);
  }
});

test('disk proc reader uses fixed read-only flags, bounded actual bytes, strict UTF-8 and closes on every outcome', { skip: process.platform !== 'linux' ? 'requires Linux reader' : false }, async () => {
  for (const mode of ['valid', 'limit', 'too-large', 'empty', 'invalid-utf8', 'read-error', 'close-error']) {
    const content = mode === 'valid' ? Buffer.from(row()) : mode === 'invalid-utf8' ? Buffer.from([0xff]) :
      mode === 'empty' ? Buffer.alloc(0) : Buffer.alloc(MAX_MOUNTINFO_BYTES + (mode === 'too-large' ? 1 : 0), 32);
    let at = 0, closed = 0;
    const openFile = async (path, flags) => {
      assert.equal(path, '/proc/self/mountinfo'); assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      return { async read(buffer, offset, length, position) {
        assert.equal(position, null); assert.equal(buffer.length, MAX_MOUNTINFO_BYTES + 1);
        if (mode === 'read-error') throw new Error('private');
        const count = Math.min(length, content.length - at, 7999); content.copy(buffer, offset, at, at + count); at += count; return { bytesRead: count };
      }, async close() { closed++; if (mode === 'close-error') throw new Error('private'); } };
    };
    if (['valid', 'limit'].includes(mode)) assert.equal(await readMountInfo({ openFile }), content.toString());
    else await assert.rejects(readMountInfo({ openFile }));
    assert.equal(closed, 1); assert.ok(at <= MAX_MOUNTINFO_BYTES + 1);
  }
});
