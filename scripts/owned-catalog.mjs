import { readFileSync } from 'node:fs';
import { inspectOwnedCatalog } from '../src/owned-catalog.mjs';
// Reads only the checked-in catalog; no user URL, secret, resource or command input.
try {
  if (process.argv.length !== 2) throw new Error('unexpected arguments');
  const input = JSON.parse(readFileSync(new URL('../catalog/owned-services.json', import.meta.url), 'utf8'));
  process.stdout.write(JSON.stringify(inspectOwnedCatalog(input), null, 2) + '\n');
} catch {
  process.stderr.write('Owned-service catalog rejected; no execution attempted\n'); process.exitCode = 1;
}
