import { createNetworkSampler } from '../src/node-telemetry/network.mjs';
import { runSamplingLoop } from '../src/node-telemetry/loop.mjs';

const stop = new AbortController(), requestStop = () => stop.abort();
process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
try {
  if (process.argv.length !== 2 || process.platform !== 'linux' || !(process.getuid() > 0)) throw new Error('Unsupported invocation');
  await runSamplingLoop({ sampler: createNetworkSampler(), signal: stop.signal, onSample: sample => console.log(JSON.stringify(sample)) });
} catch {
  console.error('Network collection stopped. Use a normal Linux user on the intended host; no credentials, external network or installation are required. Usage: node scripts/node-network.mjs');
  process.exitCode = 2;
} finally { process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop); }
