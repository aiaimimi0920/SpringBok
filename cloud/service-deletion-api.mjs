import { connectedEnabled } from './connected-api.mjs';
import { exactSba, requireSba } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';
const consentScope = plan => plan.unverifiedReferences.length ? 'delete-and-accept-unverified-references' : 'delete';

export async function serviceDeletionRequest(env, vault, session, action, input) {
  requireSba(connectedEnabled(env));
  if (action === 'delete-plan') {
    const plan = await vault.deletionPlan(session.actor, input), operationId = 'dc-' + crypto.randomUUID().replaceAll('-', ''), expiresAt = Date.now() + 120000;
    return { operationId, plan, expiresAt, confirmation: await signSession(session, 'service-delete', [operationId, plan.digest, expiresAt, consentScope(plan)]) };
  }
  exactSba(input, ['operationId', 'plan', 'expiresAt', 'confirmation', 'acceptUnverifiedReferences']);
  requireSba(Number.isSafeInteger(input.expiresAt) && input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 120000);
  requireSba(sameProof(input.confirmation, await signSession(session, 'service-delete', [input.operationId, input.plan.digest, input.expiresAt, consentScope(input.plan)])));
  return vault.deleteService(session.actor, { operationId: input.operationId, plan: input.plan, expiresAt: input.expiresAt, acceptUnverifiedReferences: input.acceptUnverifiedReferences });
}
