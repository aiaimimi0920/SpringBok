import { exact } from './protocol.mjs';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const oid = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export const STAGES = ['v1', 'v2', 'bad', 'rollback-v1'];
export function fixtureEvidence(value, binding) {
  exact(value, ['binding', 'volume', 'stages']);
  if (!hex(value.binding) || value.binding !== binding || value.volume !== 'springbok-fixture-data' || !Array.isArray(value.stages) || value.stages.length !== 4) throw new Error('invalid fixture evidence');
  const ids = new Set(), containers = new Set(); let marker, target;
  for (const [i, row] of value.stages.entries()) {
    exact(row, ['stage', 'target', 'updateId', 'image', 'configDigest', 'health', 'marker', 'containerId']);
    if (row.stage !== STAGES[i] || !oid(row.target) || !oid(row.updateId) || ids.has(row.updateId) || !digest(row.image) || !digest(row.configDigest) || !hex(row.containerId) || containers.has(row.containerId)) throw new Error('invalid fixture evidence');
    ids.add(row.updateId); containers.add(row.containerId); target ??= row.target;
    if (target !== row.target) throw new Error('fixture target changed');
    if (i === 2) { if (row.health !== 'expected-exit-1' || row.marker !== null) throw new Error('invalid failure evidence'); }
    else {
      if (row.health !== 'healthy' || !hex(row.marker)) throw new Error('invalid persistence evidence');
      marker ??= row.marker; if (marker !== row.marker) throw new Error('fixture data changed');
    }
  }
  const [v1, v2, bad, rollback] = value.stages;
  if (new Set([v1.image, v2.image, bad.image]).size !== 3 || rollback.image !== v1.image || rollback.configDigest !== v1.configDigest) throw new Error('invalid rollback evidence');
  return structuredClone(value);
}
