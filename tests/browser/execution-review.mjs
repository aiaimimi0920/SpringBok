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
backend.hook = async (path, params) => {
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
    await gateway.getByRole('button', { name: '执行真实测试', exact: true }).click();
    await dialog.getByText(image(1), { exact: true }).waitFor();
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
  await open(); const oldId = await page.evaluate(() => pendingReview.id);
  await page.goBack(); await dialog.waitFor({ state: 'hidden' });
  await open(); assert.notEqual(await page.evaluate(() => pendingReview.id), oldId);
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
  console.log('PASS M7 real Chrome with fake backend: cancel/close/Escape/late response/Back/Forward/reopen/stale tab/double confirm/restart/mobile; no Docker or credentials');
} finally { await browser?.close(); await app?.close(); controller.close(); rmSync(directory, { recursive: true, force: true }); }
