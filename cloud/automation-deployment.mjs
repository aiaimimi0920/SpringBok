import { connectedStub, connectedTaskId } from './connected-store.mjs';
import { connectedState, submitConnected } from './connected-api.mjs';
import { serviceId } from './service-instance.mjs';
import { exactSba, requireSba, canonicalSba } from './sba-control.mjs';
import { startServiceVerification } from './service-verification.mjs';

const vaultFor = (env, owner) => env.CONNECTIONS.get(env.CONNECTIONS.idFromName(`connections/v1/${owner}`));
const sameRepository = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();

// A deployment delegation is a separate, narrower mode; it grants no legacy or catalogue access.
export async function automationAnchor(env, session) {
  const scope = session.automation.deployment, owner = session.actor, vault = vaultFor(env, owner);
  const entry = (await vault.deploymentIndex(owner)).find(row => row.taskId === scope.previousTaskId);
  requireSba(entry && serviceId(entry) === scope.instanceId);
  const parent = connectedStub(env, scope.previousTaskId), { plan } = await parent.bootstrap(owner), job = await parent.inspect(owner);
  requireSba(!plan.previewOf && !plan.verificationOf && (plan.operation?.instanceId ?? scope.previousTaskId) === scope.instanceId &&
    sameRepository(plan.application.repository, scope.repository) && plan.application.sourceSha !== scope.sourceSha &&
    ['succeeded', 'deployed-unverified'].includes(job?.status) && job.result?.status === job.status);
  return { plan, vault };
}

function updatePlan(plan, scope) {
  requireSba(!plan.previewOf && !plan.verificationOf && plan.operation?.action === 'update' &&
    plan.operation.instanceId === scope.instanceId && plan.operation.previousTaskId === scope.previousTaskId &&
    sameRepository(plan.application.repository, scope.repository) && plan.application.sourceSha === scope.sourceSha && plan.policy.sourceSha === scope.sourceSha);
}

export async function automationTask(env, session, taskId) {
  connectedTaskId(taskId);
  const scope = session.automation.deployment, owner = session.actor, stub = connectedStub(env, taskId);
  const { plan } = await stub.bootstrap(owner);
  if (!plan.verificationOf) { updatePlan(plan, scope); return plan; }
  const parent = connectedStub(env, plan.verificationOf), { plan: parentPlan } = await parent.bootstrap(owner);
  updatePlan(parentPlan, scope);
  requireSba(plan.operation?.action === 'verify' && plan.operation.instanceId === scope.instanceId &&
    plan.operation.previousTaskId === plan.verificationOf && plan.application.sourceSha === scope.sourceSha &&
    sameRepository(plan.application.repository, scope.repository) && (await parent.verification(owner))?.taskId === taskId);
  return plan;
}

// Derive the draft exclusively from the trusted original task. No connection/resource listing,
// caller-selected configuration, administrator bootstrap, floating ref or new-instance path.
async function updateDraft(env, session) {
  const { plan, vault } = await automationAnchor(env, session), scope = session.automation.deployment;
  const declaration = plan.application.declaration, automatic = declaration.schemaVersion === 2;
  const draft = { action: 'preview', github: plan.connections.github, cloudflare: plan.connections.cloudflare,
    repository: scope.repository, sourceSha: scope.sourceSha, environment: plan.policy.environment,
    values: Object.fromEntries(declaration.fields.map(field => [field.path.join('.'), field.path.reduce((value, key) => value?.[key], plan.configuration)])),
    resources: automatic ? {} : Object.fromEntries(Object.entries(plan.resources).map(([key, value]) => [key, { id: value.id, revision: value.revision }])),
    instance: { id: scope.instanceId, previousTaskId: scope.previousTaskId },
    ...(automatic ? { accounts: Object.fromEntries(declaration.accounts.slice(1).map(account => [account.key, plan.accounts[account.key].connection])) } : {}) };
  return { draft, vault };
}

export async function automationDeploymentRequest(env, session, route, input) {
  const scope = session.automation.deployment;
  requireSba(scope);
  if (route === 'plan') {
    exactSba(input, ['instanceId', 'previousTaskId']);
    requireSba(input.instanceId === scope.instanceId && input.previousTaskId === scope.previousTaskId);
    const { draft, vault } = await updateDraft(env, session), plan = await vault.deploymentDraft(session.actor, draft);
    updatePlan(plan, scope);
    return { draft, plan };
  }
  if (route === 'submit') {
    exactSba(input, ['taskId', 'draft', 'plan', 'expiresAt', 'confirmation']);
    const { draft, vault } = await updateDraft(env, session);
    requireSba(canonicalSba(input.draft) === canonicalSba(draft)); updatePlan(input.plan, scope);
    if ((await vault.deploymentIndex(session.actor)).some(row => row.taskId === input.taskId)) await automationTask(env, session, input.taskId);
    return submitConnected(env, session, input);
  }
  if (route === 'verify') {
    exactSba(input, ['instanceId', 'previousTaskId']); requireSba(input.instanceId === scope.instanceId);
    const plan = await automationTask(env, session, input.previousTaskId); requireSba(!plan.verificationOf);
    return startServiceVerification(env, vaultFor(env, session.actor), session.actor, input);
  }
  requireSba(['state', 'reconcile'].includes(route)); exactSba(input, ['taskId']);
  await automationTask(env, session, input.taskId);
  return connectedState(env, session.actor, input.taskId, route === 'reconcile');
}
