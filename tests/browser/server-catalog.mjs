import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';

const f = await adminFixture({ ENABLE_CATALOG: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' });
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  let token = f.jwt(), loseResponse = false, holdRead = false, releaseRead;
  const requests = [], errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin);
    requests.push({ path: url.pathname, method: request.method() });
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token }, ...(request.postData() === null ? {} : { body: request.postData() }) });
    const body = Buffer.from(await response.arrayBuffer());
    if (holdRead && url.pathname === '/api/admin/servers' && request.method() === 'GET') {
      holdRead = false; await new Promise(resolve => { releaseRead = resolve; });
    }
    if (loseResponse && url.pathname === '/api/admin/servers' && request.method() === 'POST') {
      loseResponse = false; await route.abort(); return;
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const notice = page.locator('#catalog-notice'), rows = page.locator('#servers > li[data-server-id]');
  const posts = () => requests.filter(r => r.path === '/api/admin/servers' && r.method === 'POST').length;
  const waitReady = () => page.getByText(/目录版本 \d+；这里仅登记元数据/).waitFor();
  const waitSaved = () => page.getByText(/目录已保存（版本 \d+）/).waitFor();
  await page.goto(origin); await waitReady();
  assert.equal(await page.locator('#start').isEnabled(), false);
  await page.getByLabel('新服务器名称', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.locator('#server-add').evaluate(button => { button.click(); button.click(); }); await waitSaved();
  assert.equal(posts(), 1); assert.equal(await rows.count(), 1); assert.equal(await page.locator('#servers img').count(), 0);
  const id = await rows.first().getAttribute('data-server-id');
  assert.equal(await rows.first().locator('strong').textContent(), '<img src=x onerror=alert(1)>');
  await page.reload(); await waitReady(); assert.equal(posts(), 1); assert.equal(await rows.count(), 1);
  await page.getByRole('button', { name: '刷新目录', exact: true }).click(); await waitReady(); assert.equal(posts(), 1);
  await page.getByRole('textbox', { name: `服务器名称 ${id}`, exact: true }).fill('主服务器');
  await page.getByRole('button', { name: '保存名称', exact: true }).click(); await waitSaved();
  assert.equal(await rows.first().getAttribute('data-server-id'), id);
  assert.equal(await rows.first().locator('strong').textContent(), '主服务器');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/server-catalog-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '归档条目', exact: true }).click(); await waitSaved();
  assert.equal(await page.getByRole('button', { name: '保存名称', exact: true }).count(), 0);
  await page.getByText(/已归档（没有卸载或删除数据）/).waitFor();
  await f.restart(); await page.reload(); await waitReady(); assert.equal(await rows.first().getAttribute('data-server-id'), id);
  // 其他页面修改 revision 后，本页不能用旧快照覆盖目录。
  const session = (await f.call('/api/admin/state', { token })).json();
  assert.equal((await f.call('/api/admin/servers', { token, headers: { 'x-csrf-token': session.csrf }, body: { id: randomUUID(), revision: 3, action: 'create', name: '另一个页面' } })).status, 200);
  await page.getByLabel('新服务器名称', { exact: true }).fill('陈旧提交'); await page.locator('#server-add').click();
  await page.getByText(/目录未确认.*请求/).waitFor(); assert.equal(await page.locator('#server-add').isEnabled(), false);
  await page.locator('#catalog-refresh').click(); await waitReady(); assert.equal(await rows.count(), 2);
  // 服务端已提交但响应丢失：禁写并提示核对，刷新仅 GET，不自动换 ID 重发。
  loseResponse = true;
  await page.getByLabel('新服务器名称', { exact: true }).fill('回执丢失'); await page.locator('#server-add').click();
  await page.getByText(/请求 [a-f0-9-]{36}/).waitFor(); assert.equal(await page.locator('#server-add').isEnabled(), false);
  const writes = posts(); await page.reload(); await waitReady(); assert.equal(posts(), writes); assert.equal(await rows.count(), 3);
  await page.screenshot({ path: 'test-results/server-catalog-synthetic-mobile.png', fullPage: true });
  // 身份切换时忽略之前 owner 的迟到响应，不保留旧目录或本地凭据。
  holdRead = true; await page.locator('#catalog-refresh').click();
  const until = Date.now() + 10000; while (!releaseRead && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseRead); token = f.jwt({ sub: 'other-owner' });
  await page.locator('#refresh').click(); await waitReady(); releaseRead();
  await page.getByText('尚无服务器目录条目', { exact: true }).waitFor(); assert.equal(await rows.count(), 0);
  token = f.jwt({ email: 'denied@example.invalid' }); await page.locator('#refresh').click();
  await page.getByText(/身份、计划或记录已变化/).waitFor(); assert.equal(await page.locator('#catalog').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(requests.filter(r => ['/api/admin/preview', '/api/admin/submit'].includes(r.path) || r.path.startsWith('/node/')).length, 0);
  assert.deepEqual(errors, []);
  assert.equal((await f.call('/api/admin/state')).json().jobs.length, 0);
  console.log('PASS server catalog: real Chrome + workerd/SQLite, double click, rename/archive, restart, stale revision, lost receipt, owner switch, XSS text, desktop/mobile; no fixture or node execution');
} finally { await browser?.close(); await f.close(); }
