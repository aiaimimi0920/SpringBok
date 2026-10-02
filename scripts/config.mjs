import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { compileConfiguration } from '../src/config/compile.mjs';
let fd;
try {
  if (process.platform !== 'linux') throw new Error('CLI file boundary currently supports Linux only');
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) throw new Error('usage: node scripts/config.mjs manifest.json');
  // Read a bounded regular file only; never follow symlinks or block on a FIFO.
  fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 65536) throw new Error('manifest must be a regular file of at most 64 KiB');
  const buffer = Buffer.alloc(65537); let size = 0, count;
  while ((count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) { size += count; if (size > 65536) throw new Error('manifest exceeds 64 KiB'); }
  let input; try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))); }
  catch { throw new Error('manifest must be valid UTF-8 JSON'); }
  const result = compileConfiguration(input);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  // No filesystem path, source text, unknown key or raw value is echoed.
  const safe = error.code ? 'unable to read the manifest file' : error.message;
  process.stderr.write(`Configuration rejected: ${safe}\n`); process.exitCode = 1;
} finally { if (fd !== undefined) closeSync(fd); }
