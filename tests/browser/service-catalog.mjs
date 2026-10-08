import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';

const f = await adminFixture({ ENABLE_CATALOG: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no' });
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  let token = f.jwt(), loseResponse = false, holdRead = false, releaseRead, changeBetweenReads = false;
  const requests = [], errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin);
    requests.push({ path: url.pathname, method: request.method() });
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token }, ...(request.postData() === null ? {} : { body: request.postData() }) });
    const body = Buffer.from(await response.arrayBuffer());
    if (changeBetweenReads && url.pathname === '/api/admin/services' && request.method() === 'GET') {
      changeBetweenReads = false;
      const parsed = JSON.parse(body); parsed.revision++;
      // 不一致读的响应夹具：页面必须失败关闭，不能用混合 revision 修改。
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: JSON.stringify(parsed) }); return;
    }
    if (holdRead && url.pathname === '/api/admin/services' && request.method() === 'GET') {
      holdRead = false; await new Promise(resolve => { releaseRead = resolve; });
    }
    if (loseResponse && url.pathname === '/api/admin/services' && request.method() === 'POST') { loseResponse = false; await route.abort(); return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const rows = page.locator('#services > li[data-service-id]');
  const waitReady = () => page.getByText(/目录版本 \d+/).waitFor();
  const waitSaved = () => page.getByText(/目录已保存（版本 \d+）/).waitFor();
  const posts = () => requests.filter(r => r.path === '/api/admin/services' && r.method === 'POST').length;
  await page.goto(origin); await waitReady(); assert.equal(await page.locator('#service-add').isEnabled(), false);
  await page.locator('#server-name').fill('服务目标'); await page.locator('#server-add').click(); await waitSaved();
  const serverId = await page.locator('#servers > li[data-server-id]').getAttribute('data-server-id');
  assert.equal(await page.locator('#service-server').inputValue(), serverId);
  await page.locator('#service-name').fill('<img src=x onerror=alert(1)>');
  await page.locator('#service-add').evaluate(button => { button.click(); button.click(); }); await waitSaved();
  assert.equal(posts(), 1); assert.equal(await rows.count(), 1); assert.equal(await page.locator('#services img').count(), 0);
  const serviceId = await rows.first().getAttribute('data-service-id');
  assert.equal(await rows.first().locator('strong').textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.getByRole('button', { name: '归档条目', exact: true }).isEnabled(), false);
  await page.getByText('有关联的未归档服务，暂不能归档此服务器条目。', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: `服务名称 ${serviceId}`, exact: true }).fill('网关服务');
  await page.getByRole('button', { name: '保存服务名称', exact: true }).click(); await waitSaved();
  await f.restart(); await page.reload(); await waitReady();
  assert.equal(await rows.first().getAttribute('data-service-id'), serviceId); assert.equal(await rows.first().locator('strong').textContent(), '网关服务');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/service-catalog-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '归档服务条目', exact: true }).click(); await waitSaved();
  assert.equal(await page.getByRole('button', { name: '归档条目', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '归档条目', exact: true }).click(); await waitSaved();
  assert.equal(await rows.count(), 1); assert.equal(await page.locator('#service-server option').count(), 0); assert.equal(await page.locator('#service-add').isEnabled(), false);
  // 另一个页面改变 shared revision：陈旧服务写入被拒绝，不能重复创建。
  await page.locator('#server-name').fill('第二台'); await page.locator('#server-add').click(); await waitSaved();
  const session = (await f.call('/api/admin/state', { token })).json();
  const state = (await f.call('/api/admin/services', { token })).json();
  const liveServer = (await f.call('/api/admin/servers', { token })).json().servers.find(server => server.state === 'draft');
  assert.equal((await f.call('/api/admin/services', { token, headers: { 'x-csrf-token': session.csrf }, body: { id: randomUUID(), revision: state.revision, action: 'create', serverId: liveServer.id, name: '另一页服务' } })).status, 200);
  await page.locator('#service-name').fill('陈旧提交'); await page.locator('#service-add').click();
  await page.getByText(/目录未确认.*请求/).waitFor(); assert.equal(await page.locator('#service-add').isEnabled(), false);
  await page.locator('#catalog-refresh').click(); await waitReady(); assert.equal(await rows.count(), 2);
  loseResponse = true; await page.locator('#service-name').fill('回执丢失'); await page.locator('#service-add').click();
  await page.getByText(/目录未确认.*请求/).waitFor(); assert.equal(await page.locator('#service-add').isEnabled(), false);
  const writes = posts(); await page.reload(); await waitReady(); assert.equal(posts(), writes); assert.equal(await rows.count(), 3);
  changeBetweenReads = true; await page.locator('#catalog-refresh').click(); await page.getByText(/目录未确认/).waitFor();
  assert.equal(await page.locator('#service-add').isEnabled(), false); assert.equal(await page.locator('#server-add').isEnabled(), false);
  await page.locator('#catalog-refresh').click(); await waitReady();
  await page.screenshot({ path: 'test-results/service-catalog-synthetic-mobile.png', fullPage: true });
  holdRead = true; await page.locator('#catalog-refresh').click();
  const until = Date.now() + 10000; while (!releaseRead && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseRead); token = f.jwt({ sub: 'other-owner' }); await page.locator('#refresh').click(); await waitReady(); releaseRead();
  await page.getByText('尚无服务目录条目', { exact: true }).waitFor(); assert.equal(await rows.count(), 0); assert.equal(await page.locator('#service-server option').count(), 0);
  token = f.jwt({ email: 'denied@example.invalid' }); await page.locator('#refresh').click();
  await page.getByText(/身份、计划或记录已变化/).waitFor(); assert.equal(await page.locator('#catalog').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  assert.equal(requests.filter(r => ['/api/admin/preview', '/api/admin/submit'].includes(r.path) || r.path.startsWith('/node/')).length, 0);
  assert.equal((await f.call('/api/admin/state')).json().jobs.length, 0);
  console.log('PASS service catalog: real Chrome + workerd/SQLite, owner/reference guards, double click, rename/archive, restart, stale/mixed revision, lost receipt, late owner response, XSS text and desktop/mobile; no execution');
} finally { await browser?.close(); await f.close(); }
