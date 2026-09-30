import { readFileSync } from 'node:fs';
import { createLab } from '../src/contract.mjs';
const manifest = JSON.parse(readFileSync(new URL('../examples/services.json', import.meta.url)));
const lab = createLab(manifest);
const actor = (role) => ({ id: `demo-${role}`, role });
const run = (service, operation, role, params = {}) => lab.dispatch({ service, operation, params }, actor(role));
for (const { id } of manifest.services) {
  run(id, 'test', 'ai');
  run(id, 'test-result', 'runner', { success: true });
}
console.log('OFFLINE CONTRACT LAB: synthetic fixture evidence; nothing has been deployed.');
console.log('All four sample services stop at tested, awaiting real human acceptance.');
console.log(JSON.stringify(lab.snapshot(), null, 2));
