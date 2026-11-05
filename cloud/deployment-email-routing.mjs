import { deploymentTargets } from './deployment-contract.mjs';
import { openToken } from './connections-crypto.mjs';
import { readEmailRouting, neutralEmailRule, ownsEmailRule } from './email-routing-provider.mjs';

export const emailPlanErrors = ['email-routing-read-failed', 'email-routing-zone-mismatch', 'email-routing-not-ready', 'email-routing-rule-unsupported', 'email-routing-occupied'];
export async function checkDeploymentEmailRouting(vault, owner, declaration, configuration, accounts, continuation, transport = fetch) {
  for (const target of deploymentTargets(declaration, configuration).filter(row => row.kind === 'email-routing')) {
    const account = Object.values(accounts).find(row => row.accountId === target.accountId);
    const { row, sealed } = vault.activeConnection(account.connection.id, account.connection.revision);
    const token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed);
    const rule = await readEmailRouting(target, token, transport);
    // An identically named external Worker is not proof of a SpringBok instance.
    if (!(continuation ? rule.enabled && ownsEmailRule(rule, target.worker) : neutralEmailRule(rule))) throw new Error('email-routing-occupied');
    vault.activeConnection(row.id, row.revision);
  }
}
