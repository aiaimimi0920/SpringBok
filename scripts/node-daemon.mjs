import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstallation } from '../src/node-install/install.mjs';
import { requireInstall } from '../src/node-install/package.mjs';
import { openCredentialClient } from '../src/node-credentials/client.mjs';
import { openNodeChannelBridge } from '../src/node-channel/bridge.mjs';
import { lockDaemon } from '../src/node-daemon/lock.mjs';
import { runNodeLoop } from '../src/node-daemon/loop.mjs';
import { openHeartbeatClient } from '../src/node-heartbeat/client.mjs';

const emit = event => console.log(JSON.stringify(event));
const stop = new AbortController(), requestStop = () => {
  if (!stop.signal.aborted) { stop.abort(); emit({ event: 'stopping', executionReady: false }); }
};
process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
let bridge, releaseLock;
try {
  const args = process.argv.slice(2);
  requireInstall(args.length === 2 && args[0] === '--installation');
  requireInstall(realpathSync(fileURLToPath(new URL('../', import.meta.url))) === realpathSync(join(args[1], 'release')));
  const installed = verifyInstallation(args[1]);
  releaseLock = lockDaemon(installed.stateDirectory);
  const options = { file: installed.credentialFile, expectedOrigin: installed.record.context.origin }, role = installed.record.context.role;
  let step;
  if (role === 'execute') { bridge = openNodeChannelBridge({ ...options, directory: installed.stateDirectory }); step = () => bridge.step(); }
  else { const client = openCredentialClient(options); step = async () => (await client.inspect()).status; }
  emit({ event: 'started', role, executionReady: false });
  const heartbeat = openHeartbeatClient(options);
  const result = await runNodeLoop({ step, heartbeat: () => heartbeat.beat(stop.signal), signal: stop.signal, onEvent: emit });
  emit({ event: result, executionReady: false });
  if (result === 'blocked') process.exitCode = 2;
} catch {
  console.error('Node daemon stopped: installation, identity, protocol or persistence unconfirmed. Preserve credential, state and locks; do not automatically restart or clear them. Usage: node release/scripts/node-daemon.mjs --installation <directory>');
  process.exitCode = 2;
} finally {
  process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop);
  try { bridge?.close(); releaseLock?.(); }
  catch { console.error('Node daemon shutdown uncertain; preserve state and locks.'); process.exitCode = 2; }
}
