import assert from 'node:assert/strict';
import { SERVICES, createLab } from '../../src/contract.mjs';
import { ciClient, waitFor, completedUpdate, containerMatches } from '../../src/komodo/ci-client.mjs';
import { deploymentRequest, releaseManifest, testProcedureRequest } from '../../src/komodo/mapping.mjs';

async function main() {
  const { IMAGE_V1: v1, IMAGE_V2: v2, IMAGE_BAD: bad, KOMODO_INIT_ADMIN_PASSWORD: password } = process.env;
  assert.ok(v1 && v2 && bad && v1 !== v2 && bad !== v1);
  const client = ciClient();
  await waitFor(() => client.version(), 'Core startup');
  await client.login(password);
  delete process.env.KOMODO_INIT_ADMIN_PASSWORD;
  assert.equal((await client.call('read/GetVersion')).version, '2.3.3');
  const server = await waitFor(async () => {
    const s = await client.call('read/GetServer', { server: 'springbok-ci' });
    return s._id?.$oid ? s : null;
  }, 'initial server');
  const deployments = new Map();
  const procedures = new Map();
  for (const service of SERVICES) {
    for (const env of ['test', 'production']) {
      const req = deploymentRequest(service, env, v1);
      const created = await client.call('write/CreateDeployment', req);
      const id = created._id?.$oid; assert.match(id, /^[a-f0-9]{24}$/);
      assert.equal(created.config.server_id, server._id.$oid);
      assert.equal(created.config.network, 'none'); assert.equal(created.config.volumes, '');
      assert.equal(created.config.ports, ''); assert.equal(created.config.auto_update, false);
      deployments.set(req.name, id);
    }
    const req = testProcedureRequest(service);
    const created = await client.call('write/CreateProcedure', req);
    assert.equal(created.config.webhook_enabled, false); assert.equal(created.config.schedule_enabled, false);
    procedures.set(service, created._id.$oid);
  }
  // Actual health and immutable image identity, never just HTTP 200 / Update accepted.
  async function inspect(name, image, healthy = true) {
    return waitFor(async () => {
      const c = await client.call('read/InspectDeploymentContainer', { deployment: deployments.get(name) });
      return containerMatches(c, image, healthy) ? c : null;
    }, `${name} ${healthy ? 'healthy image' : 'failed health'}`);
  }
  async function deploy(service, env, image, viaProcedure = false, healthy = true) {
    const req = deploymentRequest(service, env, image);
    const id = deployments.get(req.name);
    await client.call('write/UpdateDeployment', { id, config: req.config });
    const current = await client.call('read/GetDeployment', { deployment: id });
    assert.equal(current.config.image.params.image, image);
    // Wait for Periphery connection without accepting a failed deployment as success.
    // Connectivity is explicitly verified through the real container inspection below.
    const path = viaProcedure ? 'execute/RunProcedure' : 'execute/Deploy';
    const type = viaProcedure ? 'RunProcedure' : 'Deploy';
    const target = viaProcedure ? procedures.get(service) : id;
    const update = await client.call(path, viaProcedure ? { procedure: target } : { deployment: id });
    const updateId = await completedUpdate(client, update, type, target);
    await inspect(req.name, image, healthy);
    console.log(`PASS real Komodo ${service}/${env} ${healthy ? 'healthy' : 'failed-health-observed'} image=${image} update=${updateId}`);
  }
  await waitFor(async () => {
    const state = await client.call('read/GetServerState', { server: 'springbok-ci' });
    return state.status === 'Ok';
  }, 'authenticated Periphery connection');
  const lab = createLab(releaseManifest(v1));
  const actor = role => ({ id: `integration-${role}`, role });
  const op = (service, operation, params = {}, role = 'ai') => lab.dispatch({ service, operation, params }, actor(role));
  async function release(service, image) {
    op(service, 'test');
    await deploy(service, 'test', image, true);
    op(service, 'test-result', { success: true }, 'runner');
    assert.throws(() => op(service, 'promote'));
    // Synthetic acceptance is only for the disposable test, never real owner approval.
    op(service, 'approve', { binding: lab.approvalBinding(service) }, 'human');
    op(service, 'promote');
    await deploy(service, 'production', image);
    op(service, 'production-result', { success: true }, 'runner');
  }
  for (const service of SERVICES) {
    await release(service, v1);
    const next = releaseManifest(v2).services.find(s => s.id === service);
    op(service, 'candidate', { artifact: v2, configDigest: next.configDigest }, 'human');
    await release(service, v2);
    const target = op(service, 'rollback').pendingRollback;
    assert.equal(target.artifact, v1);
    await deploy(service, 'production', target.artifact);
    op(service, 'rollback-result', { success: true }, 'runner');
  }
  // Real failure/recovery: a valid immutable image starts then exits before health.
  // Failed test health must prevent promotion; the known-good production remains unchanged.
  const service = 'gateway';
  const next = releaseManifest(bad).services.find(s => s.id === service);
  op(service, 'candidate', { artifact: bad, configDigest: next.configDigest }, 'human');
  // This negative test directly observes failure; it does not invent test/acceptance success.
  await deploy(service, 'test', bad, false, false);
  op(service, 'test'); op(service, 'test-result', { success: false }, 'runner');
  assert.throws(() => op(service, 'promote'));
  await inspect('springbok-gateway-production', v1);
  console.log('PASS failed test blocks promotion; production fixture retains known-good image');
  console.log('PASS Komodo 2.3.3 integration: 8 deployment mappings, 4 test-only Procedures, 4 upgrades and 4 known-good rollbacks');
  console.log('DISPOSABLE CI ONLY: synthetic acceptance, one server; no real production, UI, authentication boundary or multi-host certification');
}
main().catch(error => {
  // Avoid dumping server responses or environment; errors in this harness are sanitized.
  console.error(`FAIL integration: ${error.message}`); process.exitCode = 1;
});
