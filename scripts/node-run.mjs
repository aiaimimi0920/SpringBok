import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstallation } from '../src/node-install/install.mjs';
import { requireInstall } from '../src/node-install/package.mjs';
import { openCredentialClient } from '../src/node-credentials/client.mjs';
import { openNodeChannelBridge } from '../src/node-channel/bridge.mjs';

let bridge;
try {
  const a = process.argv.slice(2);
  requireInstall(a.length === 4 && a[0] === '--installation' && a[2] === '--action' && ['version', 'identity', 'probe'].includes(a[3]));
  requireInstall(realpathSync(fileURLToPath(new URL('../', import.meta.url))) === realpathSync(join(a[1], 'release')));
  const installed = verifyInstallation(a[1]), options = { file: installed.credentialFile, expectedOrigin: installed.record.context.origin };
  let result = installed.summary;
  if (a[3] === 'identity') result = await openCredentialClient(options).inspect();
  if (a[3] === 'probe') {
    requireInstall(installed.record.context.role === 'execute');
    bridge = openNodeChannelBridge({ ...options, directory: installed.stateDirectory });
    result = { status: await bridge.step(), operation: 'protocol-probe', executionReady: false };
  }
  console.log(JSON.stringify(result));
} catch {
  console.error('Installed node action rejected or uncertain. Preserve installation, credential, state and lock; no deployment attempted. Usage: node release/scripts/node-run.mjs --installation <directory> --action <version|identity|probe>'); process.exitCode = 1;
} finally { bridge?.close(); }
