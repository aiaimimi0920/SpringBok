import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nodeContext, nodeMailboxName, probePlan, nodePlan, nodeLedger, nodeTransition, verifyNodePlans, MAX_NODE_JOBS, PROBE_TTL_MS } from '../cloud/node-protocol.mjs';
import { submission } from '../cloud/protocol.mjs';

const context = { ownerId: 'a'.repeat(64), nodeId: randomUUID() };
const empty = () => ({ revision: 0, jobs: [] });
const request = revision => ({ requestId: randomUUID(), revision, challenge: 'b'.repeat(64) });
const receipt = (input, outcome = 'observed') => ({ protocolVersion: 2, requestId: input.requestId, planDigest: input.planDigest, challenge: input.challenge, outcome });
const move = (state, operation, value, now = 1000) => nodeTransition(state, context, operation, value, now);

test('v2 probe plans bind all server-derived scope; legacy submission is not widened', async () => {
  const value = request(0), plan = await probePlan(context, value);
  assert.equal(nodeMailboxName(context), `node/v2/${context.ownerId}/${context.nodeId}`);
  assert.deepEqual(nodePlan(plan, context), plan);
  assert.equal(plan.serviceId, null); assert.equal(plan.environment, 'control'); assert.equal(plan.operation, 'protocol-probe');
  for (const other of [{ ...context, ownerId: 'c'.repeat(64) }, { ...context, nodeId: randomUUID() }]) {
    assert.notEqual((await probePlan(other, value)).planDigest, plan.planDigest);
    assert.throws(() => nodePlan(plan, other));
  }
  for (const change of [{ protocolVersion: 1 }, { operation: 'fixture-cycle' }, { operation: 'deploy' }, { serviceId: randomUUID() }, { environment: 'production' }, { actor: 'human' }, { nodeId: 'pc2-test' }]) assert.throws(() => nodePlan({ ...plan, ...change }, context));
  for (const change of [{ ownerId: context.ownerId }, { nodeId: context.nodeId }, { operation: 'deploy' }, { planDigest: plan.planDigest }, { revision: -1 }, { challenge: 'secret' }]) await assert.rejects(probePlan(context, { ...value, ...change }));
  assert.throws(() => nodeContext({ ...context, role: 'execute' }));
  assert.throws(() => submission(plan));
  assert.throws(() => submission({ id: 'legacy', node: context.nodeId, operation: 'protocol-probe', revision: 0, challenge: value.challenge }));
});

test('claim once, scope-bound receipts, replay and unknown preservation', async () => {
  const plan = await probePlan(context, request(0));
  let state = move(empty(), 'submitProbe', plan).state;
  assert.equal(move(state, 'submitProbe', plan).changed, false);
  assert.throws(() => move(state, 'submitProbe', { ...plan, challenge: 'c'.repeat(64) }));
  assert.throws(() => move(state, 'reportProbe', receipt(plan)));
  assert.throws(() => move(state, 'pollProbe', { protocolVersion: 1 }));
  assert.throws(() => move(state, 'pollProbe', { protocolVersion: 2, nodeId: context.nodeId }));
  const delivery = move(state, 'pollProbe', { protocolVersion: 2 }); state = delivery.state;
  assert.equal(delivery.response.status, 'delivery');
  assert.equal(move(state, 'pollProbe', { protocolVersion: 2 }).response.status, 'claimed');
  const foreign = await probePlan({ ...context, nodeId: randomUUID() }, { requestId: plan.requestId, revision: 0, challenge: plan.challenge });
  assert.throws(() => move(state, 'reportProbe', receipt(foreign)));
  assert.throws(() => move(state, 'reportProbe', { ...receipt(plan), outcome: 'fixture-verified' }));
  const observed = move(state, 'reportProbe', receipt(plan)); state = observed.state;
  assert.equal(observed.response.status, 'observed');
  assert.deepEqual(move(state, 'reportProbe', receipt(plan)), { state, changed: false, response: observed.response });
  assert.throws(() => move(state, 'reportProbe', receipt(plan, 'unknown')));
  const next = await probePlan(context, request(state.revision)); state = move(state, 'submitProbe', next).state;
  state = move(state, 'pollProbe', { protocolVersion: 2 }).state;
  state = move(state, 'reportProbe', receipt(next, 'unknown')).state;
  assert.equal(move(state, 'reportProbe', receipt(next, 'unknown')).changed, false);
  assert.throws(() => move(state, 'reportProbe', receipt(next)));
  assert.equal(move(state, 'pollProbe', { protocolVersion: 2 }).response.status, 'unknown');
  assert.throws(() => move(state, 'submitProbe', { ...next, requestId: randomUUID(), revision: state.revision }));
});

test('queued expiry is not delivery; claimed timeout and late success remain unknown', async () => {
  const plan = await probePlan(context, request(0));
  const queued = move(empty(), 'submitProbe', plan).state;
  const expired = move(queued, 'pollProbe', { protocolVersion: 2 }, 1000 + PROBE_TTL_MS);
  assert.equal(expired.response.status, 'expired');
  assert.equal(move(expired.state, 'pollProbe', { protocolVersion: 2 }).response.status, 'idle');
  assert.throws(() => move(expired.state, 'reportProbe', receipt(plan)));
  const claimed = move(queued, 'pollProbe', { protocolVersion: 2 }).state;
  const late = move(claimed, 'reportProbe', receipt(plan), 1000 + PROBE_TTL_MS);
  assert.equal(late.response.status, 'unknown'); assert.equal(late.changed, true);
  assert.equal(move(late.state, 'reportProbe', receipt(plan)).changed, false);
  assert.equal(move(late.state, 'pollProbe', { protocolVersion: 2 }).response.status, 'unknown');
});

test('bounded ledgers retain all records and reject malformed state and changed digests', async () => {
  let state = empty(); let first;
  for (let index = 0; index < MAX_NODE_JOBS; index++) {
    const plan = await probePlan(context, request(state.revision)); first ??= plan;
    state = move(state, 'submitProbe', plan).state;
    state = move(state, 'pollProbe', { protocolVersion: 2 }).state;
    state = move(state, 'reportProbe', receipt(plan)).state;
  }
  assert.equal(state.jobs.length, MAX_NODE_JOBS);
  assert.throws(() => move(state, 'submitProbe', { ...first, requestId: randomUUID(), revision: state.revision }));
  assert.equal(move(state, 'submitProbe', first).changed, false);
  await verifyNodePlans(state, context);
  for (const mutate of [value => { value.jobs[0].input.ownerId = 'd'.repeat(64); }, value => { value.jobs[0].receipt.planDigest = 'sha256:' + '0'.repeat(64); }, value => { value.jobs[0].status = 'claimed'; }, value => { value.revision = -1; }, value => { value.revision++; }, value => { value.jobs.push(value.jobs[0]); }]) {
    const broken = structuredClone(state); mutate(broken); assert.throws(() => nodeLedger(broken, context));
  }
  const broken = structuredClone(state); broken.jobs[0].input.planDigest = 'sha256:' + '0'.repeat(64); broken.jobs[0].receipt.planDigest = broken.jobs[0].input.planDigest;
  await assert.rejects(verifyNodePlans(broken, context));
});
