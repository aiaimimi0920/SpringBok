import { createMemorySampler } from '../src/node-telemetry/memory.mjs';
import { runSamplingLoop } from '../src/node-telemetry/loop.mjs';

const stop = new AbortController(), requestStop = () => stop.abort();
process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
try {
  if (process.argv.length !== 2 || process.platform !== 'linux' || !(process.getuid() > 0)) throw new Error('Unsupported invocation');
  await runSamplingLoop({ sampler: createMemorySampler(), signal: stop.signal, onSample: sample => console.log(JSON.stringify(sample)) });
} catch {
  console.error('Memory collection stopped. Use a normal Linux user on the intended host; no credentials, network or installation are required. Usage: node scripts/node-memory.mjs');
  process.exitCode = 2;
} finally { process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop); }
