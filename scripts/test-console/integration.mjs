import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '../../tests/browser/node_modules/playwright/index.mjs';
import { SERVICES } from '../../src/contract.mjs';
import { deploymentRequest } from '../../src/komodo/mapping.mjs';
import { waitFor, containerMatches } from '../../src/komodo/ci-client.mjs';
import { releaseSpec } from '../../src/execution/plan.mjs';
import { loopbackClient } from '../../src/test-console/transport.mjs';
import { openTestController } from '../../src/test-console/controller.mjs';
import { openCoreBridge } from './core-bridge.mjs';
import { startTestConsole } from '../../src/test-console/server.mjs';

let stage = 'startup', bridge;
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.GITHUB_REPOSITORY !== 'aiaimimi0920/SpringBok' || process.env.SPRINGBOK_ALLOW_M6_TEST !== 'yes') throw new Error('approved temporary runner required');
  const directory = process.argv[2], coreAddress = process.argv[3];
  if (!/^\/dev\/shm\/springbok-m6\.[A-Za-z0-9]+$/.test(directory)) throw new Error('temporary directory required');
  const env = Object.fromEntries(readFileSync(join(directory, 'driver.env'), 'utf8').trim().split('\n').map(line => line.split('=')));
  const versions = { v1: env.IMAGE_V1, v2: env.IMAGE_V2, bad: env.IMAGE_BAD };
  for (const image of Object.values(versions)) assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(versions)).size, 3);
  bridge = await openCoreBridge(coreAddress);
  const client = loopbackClient(bridge.port); await waitFor(() => client.version(), 'test Core readiness');
  await client.login(env.KOMODO_INIT_ADMIN_PASSWORD); delete env.KOMODO_INIT_ADMIN_PASSWORD;
  await waitFor(async () => (await client.call('read/GetServerState', { server: 'springbok-ci' })).status === 'Ok', 'test Periphery');
  stage = 'resource-catalog';
  const targets = new Map();
  for (const service of SERVICES) for (const role of ['test', 'production']) {
    const created = await client.call('write/CreateDeployment', deploymentRequest(service, role, versions.v1));
    assert.match(created._id?.$oid || '', /^[a-f0-9]{24}$/);
    const resource = await client.call('read/GetDeployment', { deployment: created._id.$oid });
    assert.equal(resource.config.network, 'none'); assert.equal(resource.config.ports, ''); assert.equal(resource.config.volumes, '');
    targets.set(`${service}/${role}`, { id: resource._id.$oid, name: resource.name, config: resource.config });
  }
  const releases = Object.values(versions).flatMap(artifact => SERVICES.map(service => {
    const target = role => { const row = structuredClone(targets.get(`${service}/${role}`)); row.config.image.params.image = artifact; return row; };
    return { service, artifact, test: target('test'), production: target('production') };
  }));
  const manifest = { version: 1, services: releases.slice(0, 4).map(releaseSpec) };
  let sends = 0, dropNext = false;
  const transport = { async call(path, params, options) {
    if (path === 'execute/Deploy') sends++;
    const value = await client.call(path, params, options);
    if (path === 'execute/Deploy' && dropNext) { dropNext = false; throw new Error('injected lost receipt'); }
    return value;
  } };
  const options = { directory: join(directory, 'journal'), releases, manifest, versions, transport, timeoutMs: 15000 };
  let controller = openTestController(options), app, browser;
  try {
    app = await startTestConsole({ controller }); browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(app.origin); await page.getByRole('article').first().waitFor();
    assert.equal(await page.getByRole('article').count(), 4);
    await page.getByText('临时集成测试 · 非生产认证', { exact: true }).waitFor();
    const names = { gateway: 'Gateway 网关', forum: '论坛', game: '在线游戏', account: '账号服务' };
    const card = service => page.getByRole('article', { name: names[service], exact: true });
    async function settle(service, phase) {
      const stop = Date.now() + 120000;
      while (Date.now() < stop) {
        const current = await card(service).locator('.phase').textContent(); if (current === phase) return;
        const button = card(service).getByRole('button', { name: '刷新执行证据', exact: true });
        if (await button.count() && await button.isEnabled()) await button.click();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw new Error('test UI did not reach required phase');
    }
    async function executeButton(service, name) {
      await card(service).getByRole('button', { name, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '确认本次测试操作' });
      await dialog.getByText(names[service], { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '确认执行此计划', exact: true }).click();
    }
    async function accept(service) {
      const c = card(service); await c.getByRole('checkbox').check();
      await c.getByRole('button', { name: '确认测试验收', exact: true }).click(); await settle(service, '已测试验收');
    }
    async function release(service) {
      await executeButton(service, '执行真实测试'); await settle(service, '待测试验收');
      assert.equal(await card(service).getByRole('button', { name: '晋级测试版本', exact: true }).isEnabled(), false);
      await accept(service); await executeButton(service, '晋级测试版本'); await settle(service, '测试版本已晋级');
    }
    stage = 'four-service-ui-flow';
    for (const service of SERVICES) {
      await release(service);
      await card(service).getByRole('combobox').selectOption('v2'); await card(service).getByRole('button', { name: '选择候选', exact: true }).click(); await settle(service, '待测试');
      await release(service); await executeButton(service, '回滚已知成功版本'); await settle(service, '已回滚');
      const container = await client.call('read/InspectDeploymentContainer', { deployment: targets.get(`${service}/production`).id });
      assert.equal(containerMatches(container, versions.v1), true);
    }
    assert.equal(sends, 20);
    stage = 'bad-image-blocking';
    await card('gateway').getByRole('combobox').selectOption('bad'); await card('gateway').getByRole('button', { name: '选择候选', exact: true }).click(); await settle('gateway', '待测试');
    await executeButton('gateway', '执行真实测试'); await settle('gateway', '测试失败');
    assert.equal(await card('gateway').getByRole('button', { name: '确认测试验收', exact: true }).isEnabled(), false);
    assert.equal(await card('gateway').getByRole('button', { name: '晋级测试版本', exact: true }).isEnabled(), false);
    assert.equal(controller.snapshot().history.at(-1).kind, 'health-failure');
    assert.equal(containerMatches(await client.call('read/InspectDeploymentContainer', { deployment: targets.get('gateway/production').id }), versions.v1), true);
    stage = 'restart-recovery';
    // Restart with a durably known Update before reading its result; never deploy twice.
    await card('forum').getByRole('combobox').selectOption('v2'); await card('forum').getByRole('button', { name: '选择候选', exact: true }).click(); await settle('forum', '待测试');
    await executeButton('forum', '执行真实测试'); await settle('forum', '测试执行中');
    const beforeRestart = sends;
    await app.close(); controller.close(); controller = openTestController(options); app = await startTestConsole({ controller });
    await page.goto(app.origin); await settle('forum', '待测试验收'); assert.equal(sends, beforeRestart);
    await accept('forum');
    await app.close(); controller.close(); controller = openTestController(options); app = await startTestConsole({ controller });
    await page.goto(app.origin); await settle('forum', '待测试验收'); assert.equal(sends, beforeRestart);
    assert.equal(await card('forum').getByRole('button', { name: '晋级测试版本', exact: true }).isEnabled(), false);
    stage = 'unknown-receipt';
    // Lose one actual Deploy receipt. The remote operation may run; the UI must stay unknown.
    await card('gateway').getByRole('combobox').selectOption('v1'); await card('gateway').getByRole('button', { name: '选择候选', exact: true }).click(); await settle('gateway', '待测试');
    dropNext = true; await executeButton('gateway', '执行真实测试');
    await card('gateway').getByText('提交结果未知：已阻断，禁止自动重试', { exact: true }).waitFor();
    const unknownSends = sends;
    assert.throws(() => controller.preview({ revision: controller.snapshot().revision, id: 'no-bypass', service: 'gateway', operation: 'test' }));
    await app.close(); controller.close(); controller = openTestController(options); app = await startTestConsole({ controller });
    await page.goto(app.origin); await card('gateway').getByText('提交结果未知：已阻断，禁止自动重试', { exact: true }).waitFor();
    assert.equal(sends, unknownSends); assert.deepEqual(pageErrors, []);
    const ledger = readFileSync(join(directory, 'journal/execution/ledger.json'), 'utf8');
    assert.ok(!ledger.includes('jwt') && !ledger.includes('PASSWORD'));
    mkdirSync('test-results/m6', { recursive: true });
    await page.screenshot({ path: 'test-results/m6/real-test-console.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'test-results/m6/real-test-console-mobile.png', fullPage: true });
    console.log('PASS M6 real UI -> durable preparation -> Komodo -> verified container: four releases, upgrades, rollbacks; bad image blocked; restart and unknown receipt do not redeploy');
  } finally { await browser?.close(); await app?.close(); controller.close(); }
}
main().catch(() => { console.error(`FAIL M6 integration stage=${stage} (no credential or response dumps)`); process.exitCode = 1; }).finally(async () => { await bridge?.close(); });
