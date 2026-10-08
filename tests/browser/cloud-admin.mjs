import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureBackend } from '../helpers/node-fixture.mjs';
import { openFixtureExecutor } from '../../src/fixture-node/executor.mjs';
import { openFixtureBridge } from '../../src/node-bridge/bridge.mjs';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';
const backend = fixtureBackend(), f = await adminFixture({ FIXTURE_BINDING: backend.c.binding });
const directory = mkdtempSync(join(tmpdir(), 'springbok-admin-browser-'));
let browser, executor, bridge;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const token = f.jwt(), requests = [], errors = []; let holdPreview, blockPreview = false;
  await context.route('**/*', async route => {
    const req = route.request(); assert.equal(new URL(req.url()).origin, origin); requests.push({ path: new URL(req.url()).pathname, method: req.method() });
    if (blockPreview && req.url().endsWith('/api/admin/preview')) { await new Promise(resolve => { holdPreview = resolve; }); }
    const response = await f.mf.dispatchFetch(req.url(), { method: req.method(), headers: { ...req.headers(), 'cf-access-jwt-assertion': token }, ...(req.postData() === null ? {} : { body: req.postData() }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) }).catch(() => {});
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.getByText('已验证管理员：owner@example.invalid', { exact: true }).waitFor();
  const start = page.getByRole('button', { name: '检查并确认测试计划', exact: true });
  await start.click(); await page.getByRole('dialog', { name: '确认固定测试计划' }).waitFor(); await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await page.locator('#confirm').isVisible(), false);
  await start.click(); await page.getByRole('dialog', { name: '确认固定测试计划' }).waitFor(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#confirm').isVisible(), false);
  await start.click(); await page.getByRole('dialog', { name: '确认固定测试计划' }).waitFor(); await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate'))); assert.equal(await page.locator('#confirm').isVisible(), false);
  assert.equal(requests.filter(r => r.path === '/api/admin/submit').length, 0);
  blockPreview = true; await start.click(); const until = Date.now() + 10000; while (!holdPreview && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(holdPreview, 'preview request must arrive');
  await page.getByRole('button', { name: '刷新记录', exact: true }).click(); holdPreview(); blockPreview = false;
  await page.getByText('记录已刷新', { exact: true }).waitFor(); assert.equal(await page.locator('#confirm').isVisible(), false);
  await start.click(); await page.getByRole('dialog', { name: '确认固定测试计划' }).waitFor();
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/cloud-admin-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/cloud-admin-synthetic-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '确认执行', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText(/已提交 .*请刷新查看节点回执/).waitFor(); assert.equal(requests.filter(r => r.path === '/api/admin/submit').length, 1);
  await page.reload(); await page.getByText(/等待节点领取/).waitFor(); assert.equal(await start.isEnabled(), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  assert.equal((await f.call('/api/admin/state', { token })).json().audit.length, 1);
  // Actual Node bridge/executor and workerd, with a simulated Komodo transport.
  executor = openFixtureExecutor({ directory: join(directory, 'execution'), inventory: backend.inventory, transport: backend });
  bridge = openFixtureBridge({ directory: join(directory, 'bridge'), origin, token: f.bindings.NODE_TOKEN, executor, fetcher: (url, init) => f.mf.dispatchFetch(url, init) });
  assert.equal(await bridge.step(), 'fixture-verified');
  assert.equal(backend.calls.filter(c => c.path === 'execute/Deploy').length, 4);
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.getByText(/固定测试四阶段回执齐备/).waitFor();
  await page.getByText('查看四阶段实际节点回执', { exact: true }).click();
  assert.equal(await page.locator('#jobs details p').count(), 4);
  await page.getByText(/bad：expected-exit-1/).waitFor();
  await page.getByText(/rollback-v1：healthy/).waitFor();
  assert.equal(await start.isEnabled(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/cloud-admin-synthetic-receipts-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: 'test-results/cloud-admin-synthetic-receipts-desktop.png', fullPage: true });
  console.log('PASS synthetic Access identity in real workerd + Chrome: protected assets, cancel/escape/back/stale preview, one submit, refresh persistence, mobile and four-stage receipt rendering (simulated Komodo)');
} finally { bridge?.close(); executor?.close(); await browser?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }

await import('./server-catalog.mjs');
await import('./service-catalog.mjs');
await import('./node-enrollment.mjs');
await import('./node-heartbeat.mjs');
await import('./node-telemetry.mjs');
