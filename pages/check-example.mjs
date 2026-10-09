import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateRequest, validateResult } from '../src/sba/contract.mjs';
import { deploymentDeclaration, deploymentSecrets } from '../cloud/deployment-contract.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const exampleRoot = resolve(root, 'ai-docs/examples/minimal');
export async function checkExample(directory = exampleRoot) {
  const json = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
  const manifest = validateManifest(await json('.sba/manifest.json'));
  const declaration = deploymentDeclaration(await json('.sba/deployment.json'));
  if (manifest.schemaVersion !== 3 || declaration.schemaVersion !== 2) throw new Error('This guide checks manifest v3 and deployment v2');
  const expected = deploymentSecrets(declaration).sort();
  if (JSON.stringify(expected) !== JSON.stringify([...manifest.secrets].sort())) throw new Error('Deployment and manifest secret names must agree');
  const base = await realpath(resolve(directory, '.sba'));
  const entry = resolve(base, manifest.entrypoint);
  const stat = await lstat(entry);
  const rel = relative(base, await realpath(entry));
  if (!stat.isFile() || stat.isSymbolicLink() || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Entrypoint must be a regular file inside .sba');
  if (resolve(directory) === exampleRoot) {
    const request = validateRequest(await json('request.json'), manifest);
    validateResult({schemaVersion: 3, taskId: request.taskId, action: request.action, sourceSha: request.sourceSha,
      applicationVersion: request.applicationVersion, status: 'failed', checks: [], errorCode: 'EXAMPLE_NOT_IMPLEMENTED'}, request);
  }
  return { application: manifest.id, manifest: manifest.schemaVersion, deployment: declaration.schemaVersion, execution: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await checkExample(process.argv[2] ? resolve(process.argv[2]) : exampleRoot))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
