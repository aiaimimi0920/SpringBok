import { exactSba, requireSba } from './sba-control.mjs';

export const suiteRepository = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
export const workflowTarget = value => typeof value === 'string' && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml@[a-z][a-z0-9-]{1,62}$/.test(value);
export const githubScope = repository => { requireSba(suiteRepository(repository)); return 'github:' + repository.toLowerCase(); };
export const deploymentScope = value => typeof value === 'string' && (/^[a-f0-9]{32}$/.test(value) || value.startsWith('github:') && suiteRepository(value.slice(7)) && value === value.toLowerCase());

export function validateSuite(declaration, validatePath) {
  const suite = declaration.target === 'cloudflare-suite';
  requireSba(!suite || declaration.schemaVersion === 2);
  const actions = declaration.targets.filter(row => row.kind === 'github-actions');
  requireSba(!actions.length || suite && !!declaration.github);
  if (declaration.github) {
    requireSba(suite && actions.length > 0);
    exactSba(declaration.github, ['repositoryPath', 'secret']);
    validatePath(declaration.github.repositoryPath);
    requireSba(/^[A-Z][A-Z0-9_]{1,63}$/.test(declaration.github.secret));
  }
  return suite;
}

// Only the verified application source connection can supply this credential.
// Never substitute the platform executor's dispatch token.
export function suiteConfiguration(declaration, configuration, repository, get, set, environment) {
  if (!declaration.github) return;
  requireSba(suiteRepository(repository));
  set(configuration, declaration.github.repositoryPath, repository);
  for (const target of declaration.targets.filter(row => row.kind === 'github-actions')) {
    const value = get(configuration, target.path);
    requireSba(workflowTarget(value) && value.endsWith('@' + environment));
  }
}
