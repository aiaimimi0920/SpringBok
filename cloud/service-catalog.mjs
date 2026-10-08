import { readJson } from './connections-provider.mjs';
import { openToken } from './connections-crypto.mjs';
import { accountGithub } from './brand-resources.mjs';
import { connectionReference, deploymentDeclaration } from './deployment-contract.mjs';
import { sbaPolicy, requireSba, exactSba } from './sba-control.mjs';
import { createGithubExecutor } from '../src/sba/github.mjs';

export const serviceRepository = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const refName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f?#]/.test(value) && value.split('/').every(part => part && !['.', '..'].includes(part));
const page = cursor => { requireSba(typeof cursor === 'string' && /^(?:|[1-9][0-9]{0,4})$/.test(cursor)); return Number(cursor || '1'); };

export function applicationRepository(row, requested) {
  const repository = requested ?? row.target;
  requireSba(row.provider === 'github' && serviceRepository(repository) && (accountGithub(row) || repository.toLowerCase() === row.target.toLowerCase()));
  return repository;
}
export async function readApplication(env, repository, sourceSha, token, optional = false) {
  requireSba(serviceRepository(repository) && sha(sourceSha));
  const base = sbaPolicy(env);
  const value = await createGithubExecutor({ ...base.github, applicationRepository: repository }, { token }).readApplication(sourceSha, optional);
  if (value === null) return null;
  const declaration = deploymentDeclaration(value.declaration), { manifest } = value;
  requireSba(manifest.secrets.length === 1 && manifest.secrets[0] === 'CLOUDFLARE_API_TOKEN');
  return { repository, sourceSha, manifest, declaration };
}
async function head(repository, token) {
  const metadata = await readJson(`https://api.github.com/repos/${repository}`, token, true);
  requireSba(metadata.full_name?.toLowerCase() === repository.toLowerCase() && metadata.archived !== true && metadata.disabled !== true && refName(metadata.default_branch));
  const reference = await readJson(`https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, token, true);
  requireSba(reference.ref === `refs/heads/${metadata.default_branch}` && reference.object?.type === 'commit' && sha(reference.object.sha));
  return { label: metadata.default_branch, sourceSha: reference.object.sha, kind: 'branch' };
}

// Each call has a bounded page or one immutable application read. Browsing never
// creates a derived connection, registers resources or claims an execution slot.
export async function serviceCatalog(vault, owner, kind, input) {
  const keys = kind === 'catalog' ? ['github', 'cursor'] : kind === 'versions' ? ['github', 'repository', 'cursor'] : ['github', 'repository', 'sourceSha'];
  if (kind === 'application' && Object.hasOwn(input, 'defaultBranch')) {
    keys.push('defaultBranch'); requireSba(input.sourceSha === null && refName(input.defaultBranch));
  }
  exactSba(input, keys);
  connectionReference(input.github);
  vault.ctx.storage.transactionSync(() => vault.guard(owner));
  const { row, sealed } = vault.activeConnection(input.github.id, input.github.revision);
  requireSba(row.provider === 'github');
  const token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed);
  let result;
  if (kind === 'catalog') {
    const n = page(input.cursor), account = accountGithub(row);
    requireSba(account || input.cursor === '');
    const data = await readJson(account ? `https://api.github.com/user/repos?per_page=20&page=${n}&sort=full_name&direction=asc` : `https://api.github.com/repos/${row.target}`, token, true);
    const rows = account ? data : [data]; requireSba(Array.isArray(rows) && rows.length <= 20);
    const items = rows.map(item => {
      requireSba(typeof item.full_name === 'string' && item.full_name.length <= 201 && Number.isSafeInteger(item.id) && item.id > 0);
      return { repository: item.full_name, available: serviceRepository(item.full_name) && item.archived !== true && item.disabled !== true,
        ...(refName(item.default_branch) ? { defaultBranch: item.default_branch } : {}) };
    });
    result = { items, next: account && rows.length === 20 ? String(n + 1) : null };
  } else {
    const repository = applicationRepository(row, input.repository);
    if (kind === 'versions') {
      const n = page(input.cursor), items = input.cursor === '' ? [await head(repository, token)] : [];
      const tags = await readJson(`https://api.github.com/repos/${repository}/tags?per_page=20&page=${n}`, token, true);
      requireSba(Array.isArray(tags) && tags.length <= 20);
      for (const tag of tags) { requireSba(refName(tag.name) && sha(tag.commit?.sha)); items.push({ label: tag.name, sourceSha: tag.commit.sha, kind: 'tag' }); }
      result = { repository, items, next: tags.length === 20 ? String(n + 1) : null };
    } else {
      requireSba(kind === 'application' && (input.sourceSha === null || sha(input.sourceSha)));
      if (input.defaultBranch) {
        const base = sbaPolicy(vault.env);
        const present = await createGithubExecutor({ ...base.github, applicationRepository: repository }, { token }).hasApplication(input.defaultBranch);
        if (!present) {
          vault.activeConnection(row.id, row.revision);
          return { repository, sourceSha: null, status: 'absent', github: input.github };
        }
      }
      const version = input.sourceSha === null ? await head(repository, token) : { sourceSha: input.sourceSha };
      try {
        const application = await readApplication(vault.env, repository, version.sourceSha, token, true);
        result = application ? { ...application, status: 'ready', branch: version.label ?? null } : { repository, sourceSha: version.sourceSha, status: 'absent' };
      } catch (error) {
        if (error.message === 'SBA_GITHUB_RESPONSE_INVALID') throw error;
        result = { repository, sourceSha: version.sourceSha, status: 'invalid', errorCode: 'SBA_DECLARATION_UNSUPPORTED' };
      }
    }
  }
  vault.activeConnection(row.id, row.revision);
  return { ...result, github: input.github };
}
