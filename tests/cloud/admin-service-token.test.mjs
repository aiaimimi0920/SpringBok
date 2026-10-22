import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adminFixture, issuer } from './admin-fixture.mjs';
import { sbaFixture } from './sba-fixture.mjs';
import { serviceFixture, updatedSha } from './service-fixture.mjs';
const clientId = `${'c'.repeat(32)}.access`;
const ownerActor = createHash('sha256').update(JSON.stringify([issuer, 'owner-subject'])).digest('hex');
const approval = () => ({ clientId, ownerActor, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 });
const bindings = a => ({ SBA_AUTOMATION_ACCESS: JSON.stringify(a), SBA_AUTOMATION_PROOF_KEY: 'd'.repeat(64) });
const claims = extra => ({ sub: '', email: undefined, common_name: clientId, ...extra });

async function scopedFixture(t) {
  const x = await serviceFixture(), { f, service, input, github, submit, machine, receipt, auth } = x;
  t.after(() => f.close());
  const first = (await service('plan', { ...input, github, repository: 'owner/repo' })).json();
  assert.equal((await submit(first)).status, 200); receipt(await (await machine()).json(), 'deployed-unverified');
  await service('reconcile', { taskId: first.taskId });
  const a = { ...approval(), ownerActor: auth.ownerId, deployment: { instanceId: first.taskId, previousTaskId: first.taskId, repository: 'owner/repo', sourceSha: updatedSha } };
  Object.assign(f.bindings, bindings(a)); await f.restart();
  const token = f.jwt(claims()), session = (await f.call('/api/admin/sba/session', { token })).json();
  const call = (route, body, extra = {}) => f.call('/api/admin/deployments/' + route, { token, headers: { 'x-csrf-token': session.csrf }, body, ...extra });
  const plan = () => call('plan', { instanceId: first.taskId, previousTaskId: first.taskId });
  return { ...x, first, a, token, machineSession: session, call, plan };
}

const object = async (f, binding, name) => { const ns=await f.mf.getDurableObjectNamespace(binding);return ns.get(ns.idFromName(name)); };
async function cancellationScope(x,next){
  const {f,a,token}=x;
  a.deployment.cancellation={taskId:next.taskId,planDigest:next.plan.digest};
  Object.assign(f.bindings,bindings(a));await f.restart();
  const response=await f.call('/api/admin/sba/session',{token});assert.equal(response.status,200,response.text);
  const session=response.json();
  return {session,call:(route,body)=>f.call('/api/admin/deployments/'+route,{token,headers:{'x-csrf-token':session.csrf},body})};
}

test('explicit exact-task cancellation fences absent reservation and task slot before a fresh fixed-source update',async t=>{
  const x=await scopedFixture(t),{f,a,token,plan,state,first}=x,next=(await plan()).json();
  assert.equal((await x.call('cancel-unstarted',{taskId:next.taskId})).status,403,'no implicit cancellation grant');
  const {call,session}=await cancellationScope(x,next),input={taskId:next.taskId};
  assert.notEqual(session.csrf,x.machineSession.csrf,'new scope invalidates old proof');
  assert.equal((await x.call('submit',(({executionEnabled,...body})=>body)(next))).status,403);
  const draft={instanceId:first.taskId,previousTaskId:first.taskId};
  assert.equal((await call('plan',draft)).status,409,'no new preview before both fences');
  assert.equal((await call('state',input)).json().status,'cancellation-unconfirmed');
  assert.equal((await call('cancel-unstarted',{taskId:'dc-'+'9'.repeat(32)})).status,409);
  assert.equal((await f.call('/api/admin/deployments/cancel-unstarted',{token,body:input})).status,403);
  assert.equal((await x.service('cancel-unstarted',input)).status,403,'no general human recovery API');
  const response=await call('cancel-unstarted',input);assert.equal(response.status,200,response.text);
  const cancelled=response.json();assert.equal(cancelled.status,'cancelled-before-reservation');
  assert.equal(cancelled.reservationObserved,false);assert.equal(cancelled.bootstrapObserved,false);
  assert.deepEqual((await call('cancel-unstarted',input)).json(),cancelled,'repeat only confirms immutable fences');
  assert.deepEqual((await call('state',input)).json(),cancelled);
  const vault=await object(f,'CONNECTIONS','connections/v1/'+a.ownerActor),stub=await object(f,'CONNECTED_TASKS','connected/v1/'+next.taskId);
  await assert.rejects(vault.reserveDeployment(a.ownerActor,next.taskId,next.plan),'late original request cannot reserve');
  await assert.rejects(stub.initialize(a.ownerActor,next.taskId,next.plan),'late initialize cannot revive slot');
  await assert.rejects(stub.begin(a.ownerActor,{}));assert.equal(await stub.uninitialized(),false);
  const record=await vault.deploymentCancellation(a.ownerActor,next.taskId);
  await assert.rejects(stub.cancelUninitialized(a.ownerActor,{...record,planDigest:'f'.repeat(64)}));
  await assert.rejects(vault.cancelAbsentDeployment(a.ownerActor,(({cancelledAt,...identity})=>({...identity,owner:'f'.repeat(64)}))(record)));
  assert.equal(state.dispatches,1);
  const fresh=(await call('plan',draft)).json();assert.notEqual(fresh.taskId,next.taskId);
  assert.equal(fresh.plan.operation.previousTaskId,first.taskId);assert.equal(fresh.plan.application.sourceSha,updatedSha);
  assert.equal((await call('submit',(({executionEnabled,...body})=>body)(fresh))).status,200);assert.equal(state.dispatches,2);
});

test('reservation winning cancellation race stays closed without deleting, transferring or releasing the task',async t=>{
  const x=await scopedFixture(t),next=(await x.plan()).json();let vault=await object(x.f,'CONNECTIONS','connections/v1/'+x.a.ownerActor);
  await vault.reserveDeployment(x.a.ownerActor,next.taskId,next.plan);
  const {call}=await cancellationScope(x,next);
  vault=await object(x.f,'CONNECTIONS','connections/v1/'+x.a.ownerActor);
  assert.equal((await call('cancel-unstarted',{taskId:next.taskId})).status,409);
  assert.equal(await vault.deploymentCancellation(x.a.ownerActor,next.taskId),null);
  assert.equal((await vault.deploymentIndex(x.a.ownerActor))[0].taskId,next.taskId);
  assert.equal((await call('plan',{instanceId:x.first.taskId,previousTaskId:x.first.taskId})).status,409);
  assert.equal(x.state.dispatches,1);
});

test('partial dual-DO cancellation never opens re-preview and cannot cancel an initialized task',async t=>{
  const x=await scopedFixture(t),next=(await x.plan()).json();let stub=await object(x.f,'CONNECTED_TASKS','connected/v1/'+next.taskId);
  await stub.initialize(x.a.ownerActor,next.taskId,next.plan);
  const {call}=await cancellationScope(x,next);
  stub=await object(x.f,'CONNECTED_TASKS','connected/v1/'+next.taskId);
  assert.equal((await call('cancel-unstarted',{taskId:next.taskId})).status,409);
  const state=(await call('state',{taskId:next.taskId})).json();
  assert.equal(state.status,'cancellation-unconfirmed');assert.equal(state.vaultFenced,true);assert.equal(state.taskFenced,false);
  assert.equal((await call('plan',{instanceId:x.first.taskId,previousTaskId:x.first.taskId})).status,409);
  assert.equal((await stub.bootstrap(x.a.ownerActor)).taskId,next.taskId);assert.equal(x.state.dispatches,1);
});

test('orphan SBA tables fail closed and cancellation wins during asynchronous initialization',async t=>{
  const x=await scopedFixture(t),next=(await x.plan()).json(),{call}=await cancellationScope(x,next);
  const stub=await object(x.f,'CONNECTED_TASKS','connected/v1/'+next.taskId);
  await stub.seedOrphanSba();
  assert.equal((await call('cancel-unstarted',{taskId:next.taskId})).status,409);
  const partial=(await call('state',{taskId:next.taskId})).json();
  assert.equal(partial.vaultFenced,true);assert.equal(partial.taskFenced,false);
  assert.equal((await call('plan',{instanceId:x.first.taskId,previousTaskId:x.first.taskId})).status,409);
  const other='dc-'+'8'.repeat(32),clean=await object(x.f,'CONNECTED_TASKS','connected/v1/'+other);
  const record={owner:x.a.ownerActor,taskId:other,...x.a.deployment,planDigest:next.plan.digest,cancelledAt:Date.now()};
  delete record.cancellation;
  const raced=await clean.raceInitialization(x.a.ownerActor,other,next.plan,record);
  assert.equal(raced.rejected,true);assert.deepEqual(raced.cancellation,record);
  await assert.rejects(clean.bootstrap(x.a.ownerActor));await assert.rejects(clean.begin(x.a.ownerActor,{}));
  assert.equal(x.state.dispatches,1);
});

test('cancellation approval rejects malformed identities instead of widening access',async t=>{
  const x=await scopedFixture(t),good={taskId:'dc-'+'8'.repeat(32),planDigest:'a'.repeat(64)};
  for(const cancellation of [null,[],{}, {...good,extra:true},{...good,taskId:x.first.taskId},
    {...good,taskId:'other'},{...good,planDigest:'main'},{...good,planDigest:0}]){
    x.f.bindings.SBA_AUTOMATION_ACCESS=JSON.stringify({...x.a,deployment:{...x.a.deployment,cancellation}});
    await x.f.restart();assert.equal((await x.f.call('/api/admin/sba/session',{token:x.token})).status,403);
  }
});

test('bounded connected delegation defaults closed and grants no catalogue, legacy, resource or other operations', async t => {
  const x = await scopedFixture(t), { f, token, call, a, machineSession } = x;
  assert.equal(machineSession.ownerId, a.ownerActor); assert.deepEqual(machineSession.authentication.deployment, a.deployment);
  for (const path of ['/api/admin/deployments', '/api/admin/deployments/services', '/api/admin/connections', '/api/admin/resources', '/api/admin/sba/state', '/services'])
    assert.equal((await f.call(path, { token })).status, 403, path);
  for (const route of ['catalog', 'versions', 'application', 'service-state', 'delete-plan', 'delete-submit', 'resume-plan', 'restart-plan', 'import-preview'])
    assert.equal((await call(route, {})).status, 403, route);
  for (const route of ['preview', 'submit', 'reconcile', 'recover-unstarted', 'recover-authorized', 'import-preview', 'import-submit'])
    assert.equal((await f.call('/api/admin/sba/' + route, { token, body: {}, headers: { 'x-csrf-token': machineSession.csrf } })).status, 403, route);
  assert.equal((await call('plan', { ...a.deployment })).status, 409);
  assert.equal((await call('plan', { instanceId: a.deployment.instanceId, previousTaskId: a.deployment.previousTaskId }, { headers: {} })).status, 403);
  for (const deployment of [null, { ...a.deployment, extra: true }, { ...a.deployment, sourceSha: 'main' }, { ...a.deployment, instanceId: 'other' }]) {
    f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ ...a, deployment }); await f.restart();
    assert.equal((await f.call('/api/admin/sba/session', { token })).status, 403);
  }
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ ...a, deployment: { ...a.deployment, instanceId: 'dc-' + '9'.repeat(32) } }); await f.restart();
  assert.equal((await f.call('/api/admin/sba/session', { token })).status, 409);
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify(approval()); await f.restart();
  for (const route of ['plan', 'submit', 'state', 'reconcile', 'verify']) assert.equal((await call(route, {})).status, 403);
});

test('fixed-source connected update and verify preserve one-time dispatch, owner, data and exact parent lineage', async t => {
  const x = await scopedFixture(t), { f, state, call, plan, first, a, machine, receipt, token, machineSession } = x;
  const response = await plan(); assert.equal(response.status, 200, response.text);
  const next = response.json(), { executionEnabled, ...body } = next;
  assert.equal(next.plan.operation.action, 'update'); assert.equal(next.plan.application.sourceSha, updatedSha);
  assert.equal(next.draft.instance.id, first.taskId);
  for (const patch of [{ instanceId: 'dc-' + '9'.repeat(32), previousTaskId: first.taskId }, { instanceId: first.taskId, previousTaskId: 'dc-' + '9'.repeat(32) }, { action: 'preview' }])
    assert.equal((await call('plan', patch)).status, 409);
  const refreshed = f.jwt(claims({ iat: Math.floor(Date.now() / 1000) - 2 }));
  assert.equal((await f.call('/api/admin/sba/session', { token: refreshed })).json().csrf, machineSession.csrf);
  const changed = { ...a, deployment: { ...a.deployment, sourceSha: 'e'.repeat(40) } };
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify(changed); await f.restart();
  assert.notEqual((await f.call('/api/admin/sba/session', { token })).json().csrf, machineSession.csrf);
  assert.equal((await call('submit', body)).status, 403, 'old scope proof must not survive changed source');
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify(a); await f.restart();
  for (const route of ['state', 'reconcile']) for (const taskId of [first.taskId, 'dc-' + '9'.repeat(32)])
    assert.equal((await call(route, { taskId })).status, 409);
  assert.equal((await call('verify', { instanceId: first.taskId, previousTaskId: first.taskId })).status, 409);
  const outcomes = await Promise.all([call('submit', body), call('submit', body)]);
  assert.ok(outcomes.every(row => row.status === 200), JSON.stringify(outcomes)); assert.equal(state.dispatches, 2);
  assert.equal(state.request.action, 'update');
  receipt(await (await machine()).json(), 'deployed-unverified');
  const done = (await call('reconcile', { taskId: next.taskId })).json(); assert.equal(done.job.status, 'deployed-unverified');
  assert.equal((await call('submit', body)).status, 200); assert.equal(state.dispatches, 2);
  const verify = { instanceId: first.taskId, previousTaskId: next.taskId };
  assert.equal((await call('verify', verify)).status, 200); assert.equal(state.dispatches, 3);
  const child = state.request.taskId; assert.equal(state.request.action, 'verify');
  receipt(await (await machine()).json());
  assert.equal((await call('reconcile', { taskId: child })).json().job.status, 'succeeded');
  assert.equal((await call('verify', verify)).status, 200); assert.equal(state.dispatches, 3);
  assert.equal((await call('state', { taskId: next.taskId })).json().job.status, 'deployed-unverified');
  assert.equal((await plan()).status, 409, 'cannot fork the original parent');
  f.bindings.SBA_AUTOMATION_ACCESS = ''; await f.restart();
  assert.equal((await call('state', { taskId: child })).status, 403);
});

test('two distinct delegated update confirmations cannot fork the approved original parent', async t => {
  const { call, plan, state } = await scopedFixture(t);
  const left = (await plan()).json(), right = (await plan()).json(); assert.notEqual(left.taskId, right.taskId);
  const submit = ({ executionEnabled, ...body }) => call('submit', body);
  const results = await Promise.all([submit(left), submit(right)]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]); assert.equal(state.dispatches, 2);
  const loser = results[0].status === 409 ? left : right;
  assert.equal((await call('reconcile', { taskId: loser.taskId })).status, 409);
});

test('service access defaults closed, strictly validates signed shape and never accepts raw client headers', async t => {
  const f = await adminFixture(); t.after(() => f.close());
  assert.equal((await f.call('/api/admin/sba/state', { token: f.jwt(claims()) })).status, 403);
  assert.equal((await f.call('/api/admin/sba/state', { token: null, headers: { 'cf-access-client-id': clientId, 'cf-access-client-secret': 'synthetic' } })).status, 403);
  const g = await adminFixture(bindings(approval())); t.after(() => g.close());
  for (const change of [{ common_name: `${'e'.repeat(32)}.access` }, { common_name: undefined }, { email: '' }, { email: null },
    { email: 'owner@example.invalid' }, { sub: undefined }, { sub: 'foreign', email: undefined }, { type: 'service' },
    { iss: 'https://foreign.cloudflareaccess.com' }, { aud: ['f'.repeat(64)] }, { exp: Math.floor(Date.now() / 1000) - 60 }])
    assert.equal((await g.call('/api/admin/sba/state', { token: g.jwt(claims(change)) })).status, 403);
  const token = g.jwt(claims());
  assert.equal((await g.call('/api/admin/sba/state', { token: token.slice(0, -10) + 'tampered!!' })).status, 403);
  // A real human remains the old identity path even when the automation configuration is present.
  assert.equal((await g.call('/api/admin/state')).status, 200);
  assert.equal((await g.call('/api/admin/state', { token: g.jwt({ email: 'other@example.invalid', common_name: clientId }) })).status, 403);
});

test('service delegation denies malformed or inactive approval and every route outside the exact SBA scope', async t => {
  const now = Date.now(), good = approval();
  for (const value of [{ ...good, expiresAt: now - 1 }, { ...good, issuedAt: now + 60000 }, { ...good, expiresAt: good.issuedAt + 86400001 },
    { ...good, ownerActor: 'raw-owner' }, { ...good, clientId: 'unbound' }, { ...good, extra: true }, { ...good, issuedAt: 0 }, []]) {
    const f = await adminFixture(bindings(value));
    try { assert.equal((await f.call('/api/admin/sba/state', { token: f.jwt(claims()) })).status, 403); }
    finally { await f.close(); }
  }
  const f = await adminFixture(bindings(good)); t.after(() => f.close());
  const token = f.jwt(claims());
  for (const path of ['/', '/sba.js', '/resource-tree.js', '/resource-model.mjs', '/resource-tree.css', '/api/admin/resources', '/api/admin/state', '/api/admin/servers', '/api/admin/enrollments', '/api/admin/sba/new-route', '/api/admin/sba/state?key=value'])
    assert.equal((await f.call(path, { token })).status, 403, path);
  for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }])
    assert.equal((await f.call('/api/admin/sba/state', { token, headers })).status, 403);
  assert.equal((await f.call('/api/admin/sba/state', { token, method: 'POST', body: {} })).status, 403);
  f.bindings.SBA_AUTOMATION_PROOF_KEY = ''; await f.restart();
  assert.equal((await f.call('/api/admin/sba/state', { token })).status, 403);
});

test('fresh service JWTs retain bounded proof, original owner and single submit; revocation rejects old proof', async t => {
  const a = approval(), x = await sbaFixture(t, bindings(a)), f = x.f;
  const first = f.jwt(claims()), session = (await f.call('/api/admin/sba/session', { token: first })).json();
  assert.equal(session.ownerId, x.adminState.ownerId);
  assert.deepEqual(session.authentication, { type: 'access-service-token', clientId, expiresAt: a.expiresAt });
  assert.doesNotMatch(JSON.stringify(session), /proofKey|synthetic-github|synthetic-deployment-secret/);
  const headers = { 'x-csrf-token': session.csrf };
  const post = (path, body, token = first) => f.call(`/api/admin/sba/${path}`, { token, body, headers });
  const preview = await post('preview', { taskId: 'service-test-task' }); assert.equal(preview.status, 200);
  const refreshed = f.jwt(claims({ iat: Math.floor(Date.now() / 1000) - 2 }));
  assert.notEqual(first, refreshed);
  const refreshedSession = (await f.call('/api/admin/sba/session', { token: refreshed })).json();
  assert.equal(refreshedSession.csrf, session.csrf);
  assert.equal((await f.call('/api/admin/sba/submit', { token: refreshed, body: preview.json() })).status, 409);
  assert.equal((await post('submit', preview.json(), refreshed)).status, 200);
  assert.equal((await post('submit', preview.json(), refreshed)).status, 200); assert.equal(x.state.dispatches, 1);
  const userState = (await f.call('/api/admin/sba/state', { token: x.session })).json();
  assert.deepEqual((await f.call('/api/admin/sba/state', { token: refreshed })).json(), userState);
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ ...a, ownerActor: 'e'.repeat(64) }); await f.restart();
  assert.equal((await f.call('/api/admin/sba/session', { token: refreshed })).status, 409); // The original task owner is not inferred from configuration.
  f.bindings.SBA_AUTOMATION_ACCESS = JSON.stringify({ ...a, expiresAt: Date.now() - 1 }); await f.restart();
  assert.equal((await post('submit', preview.json(), refreshed)).status, 403);
  f.bindings.SBA_AUTOMATION_ACCESS = ''; await f.restart();
  assert.equal((await f.call('/api/admin/sba/session', { token: refreshed })).status, 403);
  assert.deepEqual((await f.call('/api/admin/sba/state', { token: x.session })).json(), userState);
  assert.equal(x.state.dispatches, 1);
});

test('forwarded cookies never replace or override the verified service assertion', async t => {
  const x = await sbaFixture(t, bindings(approval())), f = x.f, token = f.jwt(claims());
  const session = (await f.call('/api/admin/sba/session', { token })).json();
  for (const cookie of [`CF_Authorization=${token}`, 'CF_Authorization=untrusted; session=untrusted']) {
    const forwarded = await f.call('/api/admin/sba/session', { token, headers: { cookie } });
    assert.equal(forwarded.status, 200);
    assert.deepEqual(forwarded.json(), session);
    assert.equal((await f.call('/api/admin/sba/session', { token: null, headers: { cookie } })).status, 403);
    assert.equal((await f.call('/api/admin/sba/session', { token: f.jwt(claims({ common_name: `${'e'.repeat(32)}.access` })), headers: { cookie } })).status, 403);
    assert.equal((await f.call('/api/admin/state', { token, headers: { cookie } })).status, 403);
    assert.equal((await f.call('/api/admin/sba/session', { token, headers: { cookie, origin: 'https://foreign.invalid' } })).status, 403);
  }
  const cookie = `CF_Authorization=${token}`, body = { taskId: 'forwarded-cookie-task' };
  assert.equal((await f.call('/api/admin/sba/preview', { token, body, headers: { cookie } })).status, 409);
  assert.equal((await f.call('/api/admin/sba/preview', { token, body, headers: { cookie, 'x-csrf-token': session.csrf } })).status, 200);
  assert.equal(x.state.dispatches, 0);
});
