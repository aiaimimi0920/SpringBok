import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { fixtureTransport } from '../src/fixture-node/transport.mjs';
import { openFixtureExecutor } from '../src/fixture-node/executor.mjs';
import { openFixtureBridge } from '../src/node-bridge/bridge.mjs';
function read(path, max) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.size > max) throw new Error('invalid node input'); const bytes = Buffer.alloc(max + 1); const size = readSync(fd, bytes, 0, bytes.length, 0); if (size > max) throw new Error('large node input'); return bytes.subarray(0, size).toString('utf8'); } finally { closeSync(fd); }
}
let executor, bridge;
try {
  if (process.env.SPRINGBOK_ENABLE_FIXTURE_CYCLE !== 'yes' || process.argv.length !== 2) throw new Error('fixture disabled');
  const inventory = JSON.parse(read('/config/inventory.json', 4096));
  const transport = await fixtureTransport(read('/run/secrets/core-password', 64));
  executor = openFixtureExecutor({ directory: '/journal/execution', inventory, transport });
  bridge = openFixtureBridge({ directory: '/journal/bridge', origin: process.env.SPRINGBOK_CONTROL_ORIGIN, token: read('/run/secrets/node-token', 64), executor });
  console.log(`Fixed fixture status: ${await bridge.step()}; not a business or production acceptance`);
} catch { console.error('Fixed fixture unavailable or uncertain; preserve records before recovery'); process.exitCode = 1; }
finally { bridge?.close(); executor?.close(); }
