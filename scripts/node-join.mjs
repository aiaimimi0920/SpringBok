import { openEnrollmentClient } from '../src/node-enrollment/client.mjs';
import { readPrivateNodeJson } from '../src/node-credentials/files.mjs';

let client;
try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--grant' || args[2] !== '--state' || args[4] !== '--expected-origin') throw new Error('usage');
  const grant = readPrivateNodeJson(args[1]);
  client = openEnrollmentClient({ directory: args[3], grant, expectedOrigin: args[5] });
  const { executeDigest: _execute, observeDigest: _observe, ...result } = await client.step();
  console.log(JSON.stringify(result));
} catch {
  console.error('Node join failed or uncertain. Preserve the original grant and state; inspect before retrying. Usage: node scripts/node-join.mjs --grant <private-0600-file> --state <private-directory> --expected-origin <independently-confirmed-https-origin>');
  process.exitCode = 1;
} finally { client?.close(); }
