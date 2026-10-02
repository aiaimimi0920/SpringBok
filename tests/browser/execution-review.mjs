import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestController } from '../../src/test-console/controller.mjs';
import { startTestConsole } from '../../src/test-console/server.mjs';
import { catalog, fakeBackend, image } from '../helpers/execution.mjs';

// Real browser and real controller; backend calls are simulated. No Docker/login.
const directory = mkdtempSync(join(tmpdir(), 'springbok-review-browser-'));
const data = catalog();
data.releases.push(...data.releases.slice(0, 4).map(r => {
  const row = structuredClone(r); row.artifact = image(3);
  for (const role of ['test', 'production']) row[role].config.image.params.image = image(3);
  return row;
}));
const backend = fakeBackend(data.releases);
let inspectionMode = null, holdReadiness = false, readinessEntered, readinessAborted;
backend.hook = async (path, params, { signal } = {}) => {
  if (path === 'read/GetDeployment' && holdReadiness) {
    readinessEntered(); signal.addEventListener('abort', () => readinessAborted(), { once: true }); return new Promise(() => {});
  }
  if (path === 'read/GetServerState') return { status: 'Ok', error: 'PRIVATE_CACHE_MARKER' };
  if (path === 'write/UpdateDeployment' && inspectionMode === 'lost-configuration') throw new Error('synthetic lost configuration receipt');
  if (path === 'read/InspectDeploymentContainer' && inspectionMode === 'unhealthy') return {
    Image: image(1), State: { Status: 'running', Running: true, Paused: false, OOMKilled: false, Health: { Status: 'unhealthy' } },
  };
  if (path === 'write/UpdateDeployment') {
    const resource = backend.resources.get(params.id); resource.config = structuredClone(params.config); return structuredClone(resource);
  }
};
const options = { directory, ...data, versions: { v1: image(1), v2: image(2), bad: image(3) }, transport: backend };
let controller = openTestController(options), app, browser;
try {
  app = await startTestConsole({ controller }); browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const gateway = page.getByRole('article', { name: 'Gateway 网关', exact: true });
  const dialog = page.getByRole('dialog', { name: '确认本次测试操作' });
  const confirm = dialog.getByRole('button', { name: '确认执行此计划', exact: true });
  const open = async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/preview') && r.request().method() === 'POST');
    await gateway.getByRole('button', { name: '执行真实测试', exact: true }).click();
    await dialog.getByText(image(1), { exact: true }).waitFor();
    return (await (await response).json()).id;
  };
  await page.goto(app.origin); await gateway.waitFor();
  const before = controller.snapshot();
  for (const method of ['取消', '关闭执行确认', 'Escape']) {
    await open();
    if (method === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: method, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(controller.snapshot(), before); assert.deepEqual(backend.calls, []);
  }
  // A late read-only response must not reopen a canceled dialog.
  let releaseResponse;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  await page.route('**/api/preview', async route => { await responseGate; await route.continue(); });
  await gateway.getByRole('button', { name: '执行真实测试', exact: true }).click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); releaseResponse();
  await page.getByRole('button', { name: '刷新记录', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  await page.unroute('**/api/preview'); assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(backend.calls, []);
  // Native Back dismisses the pending plan. Reopening obtains a fresh request ID.
  await page.evaluate(() => history.pushState({}, '', '/#review-test'));
  const oldId = await open();
  await page.goBack(); await dialog.waitFor({ state: 'hidden' });
  assert.notEqual(await open(), oldId);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.goForward(); assert.equal(await dialog.isVisible(), false);
  // Another tab changes the record while the first tab is reviewing it.
  await open(); const second = await browser.newPage(); await second.goto(app.origin);
  const other = second.getByRole('article', { name: 'Gateway 网关', exact: true });
  await other.getByRole('combobox').selectOption('v2'); await other.getByRole('button', { name: '选择候选', exact: true }).click();
  await other.getByText(`候选 v2 · ${image(2)}`, { exact: true }).waitFor();
  await confirm.click(); await page.getByText('状态已变化，请刷新后重新操作', { exact: true }).waitFor();
  assert.equal(backend.executeCount, 0); assert.equal(backend.calls.length, 0);
  await gateway.getByRole('combobox').selectOption('v1'); await gateway.getByRole('button', { name: '选择候选', exact: true }).click();
  await gateway.getByText(`候选 v1 · ${image(1)}`, { exact: true }).waitFor();
  await open();
  // Synchronous duplicate confirm clicks are both delivered to JS; only one submits.
  await confirm.evaluate(button => { button.click(); button.click(); });
  await gateway.locator('.phase').filter({ hasText: /^测试执行中$/ }).waitFor();
  assert.equal(backend.executeCount, 1);
  const beforeInspection = controller.snapshot();
  const writes = () => backend.calls.filter(c => !c.path.startsWith('read/'));
  const writesBefore = structuredClone(writes());
  const evidencePanel = gateway.getByRole('region', { name: 'Gateway 网关执行证据', exact: true });
  const inspectButton = gateway.getByRole('button', { name: '查看执行证据与阻断原因', exact: true });
  const update = backend.updates.get(beforeInspection.requests.find(r => r.status === 'accepted').updateId);
  update.status = 'Queued'; await inspectButton.click(); await evidencePanel.getByRole('heading', { name: '执行仍在排队', exact: true }).waitFor();
  await inspectButton.click(); await evidencePanel.getByRole('heading', { name: '执行仍在排队', exact: true }).waitFor();
  update.status = 'Complete'; inspectionMode = 'unhealthy'; await inspectButton.click();
  await evidencePanel.getByRole('heading', { name: '健康检查未通过', exact: true }).waitFor();
  assert.deepEqual(controller.snapshot(), beforeInspection); assert.deepEqual(writes(), writesBefore);
  await page.evaluate(() => { document.querySelector('.badge').textContent = '浏览器回归 · 假后端 · 未执行容器'; });
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/execution-diagnostics-mock-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/execution-diagnostics-mock-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  inspectionMode = null; await inspectButton.click();
  await evidencePanel.getByRole('heading', { name: '当前观测满足成功核对条件', exact: true }).waitFor();
  assert.deepEqual(controller.snapshot(), beforeInspection); assert.deepEqual(writes(), writesBefore);
  await evidencePanel.getByRole('button', { name: '关闭证据说明', exact: true }).click();
  await evidencePanel.waitFor({ state: 'hidden' });
  await gateway.getByRole('button', { name: '刷新执行证据', exact: true }).click();
  await gateway.locator('.phase').filter({ hasText: /^待测试验收$/ }).waitFor();
  await gateway.getByRole('checkbox').check(); await gateway.getByRole('button', { name: '确认测试验收', exact: true }).click();
  await gateway.locator('.phase').filter({ hasText: /^已测试验收$/ }).waitFor();
  await gateway.getByRole('button', { name: '晋级测试版本', exact: true }).click();
  await dialog.getByText('临时生产角色（非真实生产）', { exact: true }).waitFor();
  // Explicit watermark prevents a fake-backend screenshot being called a deployment.
  await page.evaluate(() => { document.querySelector('.badge').textContent = '浏览器回归 · 假后端 · 未执行容器'; document.querySelector('.review-boundary').textContent = '截图为假后端浏览器回归。未执行真实容器，不是生产授权。'; });
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/execution-review-mock-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth), true);
  await page.screenshot({ path: 'test-results/execution-review-mock-mobile.png', fullPage: true });
  // Restart invalidates the old HTTP token and unused acceptance, no extra Deploy.
  const port = Number(new URL(app.origin).port); await app.close(); controller.close();
  controller = openTestController(options); app = await startTestConsole({ controller, port });
  await confirm.click(); await page.getByText('Refresh this test session', { exact: true }).waitFor();
  await gateway.locator('.phase').filter({ hasText: /^待测试验收$/ }).waitFor();
  assert.equal(backend.executeCount, 1); assert.deepEqual(errors, []);
  inspectionMode = 'lost-configuration';
  const forum = page.getByRole('article', { name: '论坛', exact: true });
  await forum.getByRole('button', { name: '执行真实测试', exact: true }).click();
  await dialog.getByText('论坛', { exact: true }).waitFor(); await confirm.click();
  await forum.locator('.phase').filter({ hasText: '结果未知 · 已阻断' }).waitFor();
  const blockedState = controller.snapshot(), callsBefore = backend.calls.length;
  await forum.getByRole('button', { name: '查看执行证据与阻断原因', exact: true }).click();
  await forum.getByRole('heading', { name: '配置准备结果未知', exact: true }).waitFor();
  assert.equal(await forum.getByRole('button', { name: '执行真实测试', exact: true }).isEnabled(), false);
  assert.deepEqual(controller.snapshot(), blockedState); assert.equal(backend.calls.length, callsBefore);
  assert.deepEqual(errors, []);
  inspectionMode = null;
  const beforeReadiness = controller.snapshot(), callsAtReadiness = backend.calls.length;
  const readiness = page.getByRole('region', { name: '固定资源只读检查', exact: true });
  const checkResources = readiness.getByRole('button', { name: '检查固定资源', exact: true });
  await checkResources.click();
  await readiness.getByRole('heading', { name: '部分资源需要核对', exact: true }).waitFor();
  assert.equal(await readiness.locator('li').count(), 8);
  assert.equal(await readiness.getByText('执行记录未知，保持阻断', { exact: true }).count(), 2);
  assert.equal(await readiness.getByText('Core 缓存：Ok', { exact: true }).count(), 8);
  await checkResources.click(); await readiness.getByText('读取完成；没有更改资源、发布记录或验收权限', { exact: true }).waitFor();
  assert.deepEqual(controller.snapshot(), beforeReadiness);
  assert.ok(backend.calls.slice(callsAtReadiness).every(c => c.path.startsWith('read/')));
  const gameTarget = data.releases.find(r => r.service === 'game').test.id;
  const originalConfig = structuredClone(backend.resources.get(gameTarget).config);
  backend.resources.get(gameTarget).config.command = 'PRIVATE_UNKNOWN_CONFIGURATION';
  await checkResources.click(); await readiness.getByText('配置或服务器映射未知', { exact: true }).waitFor();
  assert.ok(!(await readiness.textContent()).includes('PRIVATE'));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: 'test-results/resource-readiness-mock-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/resource-readiness-mock-mobile.png', fullPage: true });
  backend.resources.get(gameTarget).config = originalConfig;
  await readiness.getByRole('button', { name: '关闭检查结果', exact: true }).click();
  assert.equal(await readiness.locator('li').count(), 0);
  holdReadiness = true;
  const entered = new Promise(resolve => { readinessEntered = resolve; });
  const aborted = new Promise(resolve => { readinessAborted = resolve; });
  const callsBeforeCancel = backend.calls.length;
  await checkResources.click(); await entered;
  await readiness.getByRole('button', { name: '取消检查', exact: true }).click();
  let timeout;
  try { await Promise.race([aborted, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('HTTP cancellation did not reach the controller')), 3000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(backend.calls.length, callsBeforeCancel + 1); assert.equal(await readiness.locator('li').count(), 0);
  holdReadiness = false;
  await checkResources.click(); await readiness.getByRole('heading', { name: '部分资源需要核对', exact: true }).waitFor();
  assert.equal(await readiness.locator('li').count(), 8); assert.deepEqual(controller.snapshot(), beforeReadiness);
  assert.deepEqual(errors, []);
  // Seed local-only candidate records to exercise pagination against real journals.
  for (let i = 0; i < 24; i++) await controller.action({ revision: controller.snapshot().revision,
    id: `history-candidate-${i}`, service: 'account', operation: 'candidate', version: i % 2 ? 'v1' : 'v2' });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.locator('#history-status').filter({ hasText: '第 1 /' }).waitFor();
  const beforeHistory = controller.snapshot(), historyCalls = structuredClone(backend.calls);
  const history = page.locator('.history'), filter = page.locator('#history-service');
  await filter.selectOption('account');
  await page.locator('#history-status').getByText('共 24 条 · 第 1 / 3 页', { exact: true }).waitFor();
  assert.equal(await page.locator('#history>li').count(), 10);
  await page.locator('#history-next').click(); assert.equal(await page.locator('#history-status').textContent(), '共 24 条 · 第 2 / 3 页');
  await page.locator('#history-next').click(); assert.equal(await page.locator('#history>li').count(), 4);
  assert.equal(await page.locator('#history-next').isDisabled(), true);
  await filter.selectOption('game'); assert.equal(await page.locator('#history>li').count(), 0);
  assert.equal(await page.locator('#history-status').textContent(), '此服务暂无请求记录');
  assert.equal(await page.locator('#history-prev').isDisabled(), true);
  await filter.selectOption('forum');
  await history.getByText('论坛 · 执行测试 · 结果未知，保持阻断', { exact: true }).click();
  await history.getByText(/准备独有；未确认执行 #/).waitFor();
  assert.equal(await history.getByRole('button', { name: /执行|重试|恢复/ }).count(), 0);
  await filter.selectOption('account'); await page.locator('#history-next').click();
  await page.locator('#history>li summary').first().click();
  assert.equal(await page.locator('#history details[open]').count(), 1);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.locator('#history-status').getByText('共 24 条 · 第 1 / 3 页', { exact: true }).waitFor();
  assert.equal(await page.locator('#history details[open]').count(), 0);
  await page.locator('#audit>summary').click();
  await page.locator('#audit-next').click(); assert.match(await page.locator('#audit-status').textContent(), /第 2 \/ /);
  await page.locator('#audit-source').selectOption('preparation');
  assert.equal(await page.locator('#audit-prev').isDisabled(), true);
  await page.locator('#audit>summary').click();
  await filter.selectOption('all'); await page.locator('#history>li summary').first().click();
  await history.evaluate(section => { const p = document.createElement('p'); p.textContent = '浏览器回归 · 假后端 · 未执行容器'; section.prepend(p); });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await history.screenshot({ path: 'test-results/release-history-mock-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await history.screenshot({ path: 'test-results/release-history-mock-mobile.png' });
  assert.deepEqual(controller.snapshot(), beforeHistory); assert.deepEqual(backend.calls, historyCalls);
  assert.deepEqual(errors, []);
  console.log('PASS M7/M8/M9 real Chrome with fake backend: cancel/close/Escape/late response/Back/Forward/reopen/stale tab/double confirm/restart/mobile; queued/unhealthy/ready/configuration-unknown inspections never write or unblock; fixed resource checks repeat/cancel/reopen without writes, unknown config and cached status; no Docker or credentials');
} finally { await browser?.close(); await app?.close(); controller.close(); rmSync(directory, { recursive: true, force: true }); }
