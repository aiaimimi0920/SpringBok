import { openProbeBridge } from '../src/node-bridge/bridge.mjs';
// Explicit one-step invocation. No daemon install, credentials creation or Docker.
let bridge;
try {
  if (process.argv.length !== 3 || process.env.SPRINGBOK_ENABLE_PROTOCOL_PROBE !== 'yes') throw new Error('disabled');
  bridge = openProbeBridge({ directory: process.argv[2], origin: process.env.SPRINGBOK_CONTROL_ORIGIN, token: process.env.SPRINGBOK_NODE_TOKEN });
  const status = await bridge.step();
  process.stdout.write(`Protocol probe: ${status}; deployment not executed\n`);
} catch { process.stderr.write('Protocol probe unavailable; no deployment attempted\n'); process.exitCode = 1; }
finally { bridge?.close(); }
