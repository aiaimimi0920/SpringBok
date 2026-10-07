import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('private assets always enter the Worker and management defaults reject access without credentials in the browser', () => {
  const config = JSON.parse(readFileSync(new URL('../cloud/wrangler.jsonc', import.meta.url)));
  assert.equal(config.assets.run_worker_first, true); assert.equal(config.assets.binding, 'ASSETS'); assert.equal(config.vars.ENABLE_ADMIN, 'no'); assert.equal(config.vars.ADMIN_EMAILS, '[]');
  assert.equal(config.vars.ENABLE_CATALOG, 'no');
  assert.equal(config.vars.ENABLE_SBA, 'no');
  assert.equal(config.vars.ENABLE_NODE_MAILBOX, 'no');
  assert.equal(config.vars.ENABLE_NODE_ENROLLMENT, 'no');
  assert.equal(config.vars.ENABLE_NODE_CREDENTIALS, 'no');
  assert.equal(config.vars.ENABLE_NODE_CHANNEL, 'no');
  assert.equal(config.vars.ENABLE_NODE_TELEMETRY, 'no');
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'TARGET', class_name: 'TargetMailbox' }, { name: 'REGISTRY', class_name: 'OwnerCatalog' }, { name: 'NODES', class_name: 'NodeMailbox' }, { name: 'TELEMETRY', class_name: 'NodeTelemetry' }, { name: 'SBA_TASKS', class_name: 'SbaDeployment' }, { name: 'CONNECTIONS', class_name: 'ConnectionVault' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['TargetMailbox'] }, { tag: 'v2-catalog', new_sqlite_classes: ['OwnerCatalog'] }, { tag: 'v3-node-mailbox', new_sqlite_classes: ['NodeMailbox'] }, { tag: 'v4-node-telemetry', new_sqlite_classes: ['NodeTelemetry'] }, { tag: 'v5-sba-deployment', new_sqlite_classes: ['SbaDeployment'] }, { tag: 'v6-connections', new_sqlite_classes: ['ConnectionVault'] }]);
  for (const file of ['deploy.html', 'deploy.js', 'resources.html', 'resources.js', 'settings.html', 'connections.js', 'connections.css', 'index.html', 'style.css', 'app.js', 'catalog.js', 'enrollment.js', 'telemetry.js', 'sba.js']) {
    const source = readFileSync(new URL(`../public/cloud-admin/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /CONTROL_TOKEN|NODE_TOKEN|cf-access-jwt-assertion|localStorage|sessionStorage|innerHTML/);
  }
  const worker = readFileSync(new URL('../cloud/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /this\.adminEnabled && \['submit', 'state'\]/);
  assert.equal(JSON.parse(readFileSync(new URL('../cloud/package.json', import.meta.url))).dependencies.jose, '6.2.12');
  assert.match(JSON.parse(readFileSync(new URL('./cloud/package.json', import.meta.url))).scripts.test, /\bservices\.test\.mjs\b/);
  assert.match(JSON.parse(readFileSync(new URL('./cloud/package.json', import.meta.url))).scripts.test, /\bnode-mailbox\.test\.mjs\b/);
  assert.match(JSON.parse(readFileSync(new URL('./cloud/package.json', import.meta.url))).scripts.test, /\bcredentials\.test\.mjs\b/);
  assert.match(JSON.parse(readFileSync(new URL('./cloud/package.json', import.meta.url))).scripts.test, /\bnode-channel\.test\.mjs\b/);
});
