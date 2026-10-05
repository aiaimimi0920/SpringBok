import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { openEnrollmentClient } from '../src/node-enrollment/client.mjs';

let client;
try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--grant' || args[2] !== '--state' || args[4] !== '--expected-origin') throw new Error('usage');
  const fd = openSync(args[1], constants.O_RDONLY | constants.O_NOFOLLOW);
  let grant;
  try {
    const stat = fstatSync(fd);
    if (process.platform !== 'linux' || !stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('private Linux grant file required');
    grant = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)));
  } finally { closeSync(fd); }
  client = openEnrollmentClient({ directory: args[3], grant, expectedOrigin: args[5] });
  const { executeDigest: _execute, observeDigest: _observe, ...result } = await client.step();
  console.log(JSON.stringify(result));
} catch {
  console.error('Node join failed or uncertain. Preserve the original grant and state; inspect before retrying. Usage: node scripts/node-join.mjs --grant <private-0600-file> --state <private-directory> --expected-origin <independently-confirmed-https-origin>');
  process.exitCode = 1;
} finally { client?.close(); }
