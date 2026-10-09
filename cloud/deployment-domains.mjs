import { requireSba, exactSba } from './sba-control.mjs';
import { connectionReference } from './deployment-contract.mjs';
import { readJson } from './connections-provider.mjs';
import { openToken } from './connections-crypto.mjs';

const hostname = value => typeof value === 'string' && value.length <= 253 && value.split('.').length > 1 && value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
export const domainPlanErrors = ['domain-registration-stale', 'domain-zone-read-failed', 'domain-zone-mismatch', 'domain-dns-read-failed', 'domain-dns-not-empty'];
const check = (condition, code) => { if (!condition) throw new Error(code); };
async function domainRead(url, token, transport, code) {
  try { return await readJson(url, token, false, transport); }
  catch { throw new Error(code); }
}

// Zones are shared parents, never provisioned/deleted service resources. Resolve
// only selected registrations and re-read provider ownership at plan AND submit.
export async function resolveDeploymentDomains(vault, owner, input, declaration, accounts, transport) {
  const choices = input.domains ?? {}, values = { ...input.values }, names = new Set();
  requireSba(!Object.keys(choices).length || declaration.schemaVersion === 2 && !input.instance);
  for (const [path, choice] of Object.entries(choices)) {
    const target = declaration.targets.find(row => row.kind === 'domain' && row.path.join('.') === path);
    requireSba(target && !Object.hasOwn(values, path));
    exactSba(choice, ['resource', 'subdomain']);
    const reference = connectionReference(choice.resource), account = accounts[target.account];
    requireSba(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(choice.subdomain));
    const stored = vault.ctx.storage.sql.exec('SELECT metadata FROM resources WHERE id=?', reference.id).toArray()[0];
    check(stored, 'domain-registration-stale'); const zone = JSON.parse(stored.metadata);
    check(zone.kind === 'zone' && zone.revision === reference.revision && zone.accountId === account.accountId &&
      zone.connectionId === account.connection.id && zone.connectionRevision === account.connection.revision && /^[a-f0-9]{32}$/.test(zone.remoteId), 'domain-registration-stale');
    const { row, sealed } = vault.activeConnection(account.connection.id, account.connection.revision);
    const token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed);
    const result = await domainRead(`https://api.cloudflare.com/client/v4/zones/${zone.remoteId}`, token, transport, 'domain-zone-read-failed');
    check(result.success === true && result.result?.id === zone.remoteId && result.result.account?.id === account.accountId &&
      result.result.status === 'active' && result.result.name === zone.name && hostname(zone.name), 'domain-zone-mismatch');
    const domain = `${choice.subdomain}.${zone.name}`;
    requireSba(hostname(domain) && !names.has(domain)); names.add(domain);
    const dns = await domainRead(`https://api.cloudflare.com/client/v4/zones/${zone.remoteId}/dns_records?name=${encodeURIComponent(domain)}&per_page=5`, token, transport, 'domain-dns-read-failed');
    check(dns.success === true && Array.isArray(dns.result) && Number.isSafeInteger(dns.result_info?.total_count), 'domain-dns-read-failed');
    check(dns.result.length === 0 && dns.result_info.total_count === 0, 'domain-dns-not-empty');
    vault.activeConnection(row.id, row.revision);
    const current = vault.ctx.storage.sql.exec('SELECT metadata FROM resources WHERE id=?', reference.id).toArray()[0];
    check(current && JSON.parse(current.metadata).revision === reference.revision, 'domain-registration-stale');
    values[path] = `https://${domain}`;
  }
  return values;
}
