import { installNode } from '../src/node-install/install.mjs';

try {
  const a = process.argv.slice(2);
  if (a.length !== 12 || a[0] !== '--package' || a[2] !== '--sha256' || a[4] !== '--credential' || a[6] !== '--expected-origin' || a[8] !== '--role' || a[10] !== '--directory') throw new Error('usage');
  console.log(JSON.stringify(installNode({ packageDirectory: a[1], expectedSha256: a[3], credentialFile: a[5], expectedOrigin: a[7], role: a[9], directory: a[11] })));
} catch {
  console.error('Node installation rejected or uncertain. Preserve package, role credential and destination; do not delete state or retry with new secrets. Usage: node <trusted-checkout>/scripts/node-install.mjs --package <unexecuted-package> --sha256 <trusted-manifest-sha256> --credential <private-role-file> --expected-origin <trusted-https-origin> --role <execute|observe> --directory <private-new-directory>'); process.exitCode = 1;
}
