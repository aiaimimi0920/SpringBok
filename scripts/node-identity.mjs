import { openCredentialClient } from '../src/node-credentials/client.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--credential' || args[2] !== '--expected-origin') throw new Error('usage');
  const client = openCredentialClient({ file: args[1], expectedOrigin: args[3] });
  console.log(JSON.stringify(await client.inspect()));
} catch {
  console.error('Node identity denied or unconfirmed. Preserve the credential; inspect the configured origin and role. Usage: node scripts/node-identity.mjs --credential <private-role-file> --expected-origin <independently-confirmed-https-origin>');
  process.exitCode = 1;
}
