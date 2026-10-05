import { openNodeChannelBridge } from '../src/node-channel/bridge.mjs';

let bridge;
try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--credential' || args[2] !== '--expected-origin' || args[4] !== '--state') throw new Error('usage');
  bridge = openNodeChannelBridge({ file: args[1], expectedOrigin: args[3], directory: args[5] });
  console.log(JSON.stringify({ status: await bridge.step(), executionReady: false, operation: 'protocol-probe' }));
} catch {
  console.error('Node channel denied or uncertain. Preserve credential, journal and lock; no deployment attempted. Usage: node scripts/node-channel.mjs --credential <private-execute-file> --expected-origin <independently-confirmed-https-origin> --state <private-channel-state>');
  process.exitCode = 1;
} finally { bridge?.close(); }
