import { openEnrollmentClient } from '../src/node-enrollment/client.mjs';
import { readPrivateNodeJson } from '../src/node-credentials/files.mjs';

let client;
try {
  const args = process.argv.slice(2);
  if (args.length !== 8 || args[0] !== '--grant' || args[2] !== '--state' || args[4] !== '--expected-origin' || args[6] !== '--output') throw new Error('usage');
  client = openEnrollmentClient({ grant: readPrivateNodeJson(args[1]), directory: args[3], expectedOrigin: args[5] });
  console.log(JSON.stringify(client.exportCredentials(args[7])));
} catch {
  console.error('Node credential export denied or uncertain. Preserve grant, state and output; do not replace secrets. Usage: node scripts/node-credential-export.mjs --grant <private-file> --state <joined-state> --expected-origin <independently-confirmed-https-origin> --output <private-role-directory>');
  process.exitCode = 1;
} finally { client?.close(); }
