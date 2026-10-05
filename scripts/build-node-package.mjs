import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNodePackage } from '../src/node-install/package.mjs';

try {
  const args = process.argv.slice(2); if (args.length !== 2 || args[0] !== '--output') throw new Error('usage');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  const revision = git(['rev-parse', '--verify', 'HEAD']).trim();
  const result = buildNodePackage({ directory: args[1], revision, readSource: path => git(['show', `${revision}:${path}`]) });
  console.log(JSON.stringify(result));
} catch {
  console.error('Node package build failed. Use a reviewed committed revision and a new output directory; preserve partial output. Usage: node scripts/build-node-package.mjs --output <new-directory>'); process.exitCode = 1;
}
