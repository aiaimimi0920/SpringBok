import { connectedEnabled } from './connected-api.mjs';
import { exactSba, requireSba } from './sba-control.mjs';
import { sameProof, signSession } from './access.mjs';

export async function serviceRetirementRequest(env, vault, session, action, input) {
  requireSba(connectedEnabled(env));
  if (action === 'retire-plan') {
    const plan = await vault.retirementPlan(session.actor, input), operationId = 'dc-' + crypto.randomUUID().replaceAll('-', ''), expiresAt = Date.now() + 120000;
    return { operationId, plan, expiresAt, confirmation: await signSession(session, 'service-retire', [operationId, plan.digest, expiresAt]) };
  }
  exactSba(input, ['operationId', 'plan', 'expiresAt', 'confirmation']);
  requireSba(Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000
    && sameProof(input.confirmation, await signSession(session, 'service-retire', [input.operationId, input.plan.digest, input.expiresAt])));
  return vault.retireService(session.actor, { operationId: input.operationId, plan: input.plan, expiresAt: input.expiresAt });
}
