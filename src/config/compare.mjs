import { compileConfiguration } from './compile.mjs';
import { digest } from '../execution/plan.mjs';
import { SERVICES } from '../contract.mjs';
const fields = ['image', ...['test', 'production'].flatMap(role => ['serverId', 'deploymentName', 'ports', 'volumes', 'secretRefs'].map(field => `${role}.${field}`))];
const valueAt = (service, path) => service ? path.split('.').reduce((value, key) => value[key], service) : null;
export function compareConfigurations(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join() !== 'baseline,candidate') throw new Error('comparison: expected baseline and candidate');
  for (const manifest of [input.baseline, input.candidate]) if (Buffer.byteLength(JSON.stringify(manifest) || '') > 65536) throw new Error('comparison: each manifest must be at most 64KiB');
  const baseline = compileConfiguration(input.baseline), candidate = compileConfiguration(input.candidate);
  if (baseline.manifest.project !== candidate.manifest.project) throw new Error('comparison: project identifiers must match');
  const changes = SERVICES.flatMap(service => {
    const before = baseline.manifest.services.find(row => row.id === service), after = candidate.manifest.services.find(row => row.id === service);
    if (!before && !after) return [];
    const differences = fields.flatMap(field => {
      const previous = valueAt(before, field), next = valueAt(after, field);
      return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ field, before: previous, after: next }];
    });
    const status = !before ? 'added' : !after ? 'removed' : differences.length ? 'modified' : 'unchanged';
    const requirements = [
      ...(!after ? ['review-service-removal-no-delete-command-generated'] : []),
      ...(before && after && differences.some(d => /\.(serverId|deploymentName)$/.test(d.field)) ? ['review-target-change-not-an-in-place-update'] : []),
      ...(differences.some(d => d.field.endsWith('.volumes') && (d.before?.length || d.after?.length)) ? ['review-storage-change-backup-and-migration'] : []),
      ...(differences.some(d => d.field.endsWith('.ports') && [...(d.before || []), ...(d.after || [])].some(p => p.hostIp === '0.0.0.0')) ? ['review-external-network-change'] : []),
      ...(differences.some(d => d.field.endsWith('.secretRefs') && (d.before?.length || d.after?.length)) ? ['review-unresolved-reference-change'] : []),
    ];
    return [{ service, status, differences, requirements }];
  });
  const binding = { version: 1, baselineManifestDigest: baseline.manifestDigest, candidateManifestDigest: candidate.manifestDigest, changes };
  return { mode: 'deployment-change-review', baselineKind: 'user-provided-config-not-runtime-evidence', executionReady: false,
    readiness: false, executable: false, ...binding, reviewDigest: digest(binding),
    baseline: baseline.manifest, candidate,
    unresolved: ['resolve-real-deployment-ids-and-configuration-ownership', 'resolve-complete-live-configuration',
      'verify-registry-digest-to-platform-local-image-id', 'collect-current-execution-evidence-and-human-acceptance'] };
}
