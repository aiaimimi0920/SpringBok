import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { nodeCredential } from '../../cloud/credential-contract.mjs';
import { cpuSample, memorySample, telemetryInput, verifyTelemetryResult, requireTelemetry } from '../../cloud/telemetry-contract.mjs';
import { readPrivateNodeJson } from '../node-credentials/files.mjs';
import { fetchCredentialJson } from '../node-credentials/client.mjs';
import { createCpuSampler } from './cpu.mjs';
import { createMemorySampler } from './memory.mjs';
import { createDiskSampler } from './disk-process.mjs';
import { diskReport } from '../../public/cloud-admin/disk-contract.mjs';

export const MAX_PENDING_MS = 90000;
export function openTelemetryClient({ file, expectedOrigin, fetcher = fetch, bootId = randomUUID(), sampler = createCpuSampler(), memorySampler = createMemorySampler(), diskSampler, monotonic = () => performance.now() }) {
  const credential = nodeCredential(readPrivateNodeJson(file), expectedOrigin); requireTelemetry(credential.role === 'observe');
  telemetryInput('start', { protocolVersion: 2, bootId, previousGeneration: 0 });
  let previousGeneration, generation, sequence = 0, pending, inFlight = false;
  const clock = () => { const value = monotonic(); requireTelemetry(Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER); return value; };
  async function call(operation, input, signal) {
    const value = await fetchCredentialJson(fetcher, `${expectedOrigin}/node/v2/telemetry/observe/${credential.ownerId}/${credential.nodeId}/${credential.enrollmentId}/${operation}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify(telemetryInput(operation, input)),
    }, 8192); // Only telemetry ACKs opt into 8 KiB; identity/heartbeat remain 4 KiB.
    return verifyTelemetryResult(value, credential, operation, input);
  }
  return Object.freeze({ async upload(signal) {
    requireTelemetry(!inFlight); if (signal.aborted) return;
    inFlight = true;
    try {
      if (pending) { const age = clock() - pending.createdAt; if (age < 0 || age >= MAX_PENDING_MS) pending = undefined; }
      if (!pending) {
        const createdAt = clock(), cpu = cpuSample(await sampler.sample());
        if (signal.aborted) return;
        const memory = memorySample(await memorySampler.sample());
        if (signal.aborted) return;
        diskSampler ??= createDiskSampler({ signal });
        const disk = diskReport(await diskSampler.sample());
        if (signal.aborted) return;
        pending = { cpu, memory, disk, createdAt };
      }
      if (previousGeneration === undefined) previousGeneration = (await call('read', { protocolVersion: 2 }, signal)).generation;
      if (signal.aborted) return;
      if (generation === undefined) generation = (await call('start', { protocolVersion: 2, bootId, previousGeneration }, signal)).generation;
      if (signal.aborted) return;
      const age = clock() - pending.createdAt;
      if (age < 0 || age >= MAX_PENDING_MS) { pending = undefined; return 'dropped'; }
      pending.input ??= telemetryInput('sample', { protocolVersion: 2, bootId, generation, sequence: ++sequence, cpu: pending.cpu, sampleVersion: 3, memory: pending.memory, disk: pending.disk });
      const result = await call('sample', pending.input, signal);
      if (result.status === 'recorded') pending = undefined;
      return result.status;
    } finally { inFlight = false; }
  } });
}
