import { connectedEnabled } from './connected-api.mjs';
import { exactSba, requireSba } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';

export async function serviceDeletionRequest(env, vault, session, action, input) {
  requireSba(connectedEnabled(env));
  if (action === 'delete-plan') {
    const plan = await vault.deletionPlan(session.actor, input), operationId = 'dc-' + crypto.randomUUID().replaceAll('-', ''), expiresAt = Date.now() + 120000;
    return { operationId, plan, expiresAt, confirmation: await signSession(session, 'service-delete', [operationId, plan.digest, expiresAt]) };
  }
  exactSba(input, ['operationId', 'plan', 'expiresAt', 'confirmation']);
  requireSba(Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000);
  requireSba(sameProof(input.confirmation, await signSession(session, 'service-delete', [input.operationId, input.plan.digest, input.expiresAt])));
  return vault.deleteService(session.actor, { operationId: input.operationId, plan: input.plan, expiresAt: input.expiresAt });
}
