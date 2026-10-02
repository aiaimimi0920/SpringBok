import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

// This checkout is only read as evidence; none of its source is executed.
const milestone = process.argv[3] || 'm6';
assert.ok(['m6', 'm10'].includes(milestone));
const baseline = resolve(process.argv[2] || `.evidence/${milestone}`);
const evidence = JSON.parse(readFileSync(new URL(milestone === 'm6' ? '../../docs/test-console-evidence.json' : '../../docs/combined-console-evidence.json', import.meta.url)));
const evolution = JSON.parse(readFileSync(new URL(milestone === 'm6' ? '../../docs/test-console-evolution.json' : '../../docs/combined-console-evolution.json', import.meta.url)));
const git = arg => execFileSync('git', ['-C', baseline, 'rev-parse', arg], { encoding: 'utf8' }).trim();
assert.equal(git('HEAD'), evidence.source_commit);
assert.equal(git('HEAD^{tree}'), evidence.source_tree);
assert.equal(evolution.baseline_commit, evidence.source_commit);
assert.equal(evolution.baseline_tree, evidence.source_tree);
const hash = data => createHash('sha256').update(data).digest('hex');
const changed = [];
for (const [path, expected] of Object.entries(evidence.execution_files_sha256)) {
  assert.match(path, /^(src|scripts|public|examples|tests)\/[a-zA-Z0-9_./-]+$/);
  assert.ok(!path.split('/').includes('..'));
  assert.equal(hash(readFileSync(join(baseline, path))), expected, `historical evidence: ${path}`);
  if (hash(readFileSync(new URL(`../../${path}`, import.meta.url))) !== expected) changed.push(path);
}
assert.deepEqual(changed.sort(), [...evolution.changed_inputs].sort());
console.log(`PASS: exact historical ${milestone.toUpperCase()} commit/tree and all ${Object.keys(evidence.execution_files_sha256).length} evidence hashes; later changes explicitly declared`);
