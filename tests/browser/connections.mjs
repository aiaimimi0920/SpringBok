import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connectionsFixture, fakeToken } from '../cloud/connections-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';
const { f, state } = await connectionsFixture();
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } }), errors = [];
  let token = f.jwt(), posts = 0;
  await context.route('**/*', async route => {
    const request = route.request(); assert.equal(new URL(request.url()).origin, origin);
    if (request.method() === 'POST') posts++;
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token },
      ...(request.postData() === null ? {} : { body: request.postData() }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/'); await page.getByRole('link', { name: '连接设置' }).click();
  await page.getByText('连接已刷新', { exact: true }).waitFor();
  await page.locator('#connection-name').fill('生产 Cloudflare'); await page.locator('#connection-target').fill('a'.repeat(32));
  await page.locator('#connection-token').fill(fakeToken);
  await page.locator('#connection-save').evaluate(button => { button.click(); button.click(); });
  await page.getByText('连接已保存，只读验证通过', { exact: true }).waitFor(); assert.equal(posts, 1);
  assert.equal(await page.locator('#connection-token').inputValue(), '');
  await page.reload(); await page.getByText('连接已刷新', { exact: true }).waitFor();
  assert.equal(await page.locator('#connections-list li').count(), 1);
  await page.locator('#connection-provider').selectOption('github');
  await page.locator('#connection-name').fill('应用仓库'); await page.locator('#connection-target').fill('owner/repo'); await page.locator('#connection-token').fill(fakeToken);
  await page.locator('#connection-save').click(); await page.getByText('连接已保存，只读验证通过', { exact: true }).waitFor();
  assert.equal(posts, 2); assert.equal(await page.locator('#connections-list li').count(), 2);
  const directory = process.env.CONNECTIONS_EVIDENCE_DIR ?? 'test-results'; await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, 'connections-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const first = page.locator('#connections-list li').first(); await first.getByRole('button', { name: '停用', exact: true }).click();
  await page.keyboard.press('Escape'); assert.equal(posts, 2);
  await first.getByRole('button', { name: '停用', exact: true }).click(); await page.locator('#connection-disable-confirm').click();
  await page.getByText('连接已停用', { exact: true }).waitFor(); assert.equal(posts, 3);
  assert.equal(await page.locator('#connections-list li').first().getByRole('button', { name: '重新验证' }).isDisabled(), false); // Replaced row is appended.
  state.reject = true; await page.locator('#connections-list li').first().getByRole('button', { name: '重新验证' }).click();
  await page.getByText('验证失败，已标记为不可用；请检查权限或平台状态', { exact: true }).waitFor();
  assert.match(await page.locator('#connections-list').textContent(), /验证失败，不可用/);
  assert.doesNotMatch(await page.locator('body').textContent(), new RegExp(fakeToken));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.screenshot({ path: join(directory, 'connections-mobile.png'), fullPage: true });
  await page.locator('#connection-token').fill(fakeToken); token = 'invalid'; await page.locator('#connections-refresh').click();
  await page.getByText('身份验证失败，请重新登录', { exact: true }).waitFor();
  assert.equal(await page.locator('#connection-token').inputValue(), ''); assert.equal(await page.locator('#connection-save').isDisabled(), true);
  assert.equal(await page.locator('#connections-list li').count(), 0); assert.deepEqual(errors, []);
  console.log('PASS Chrome + workerd connection settings: two providers, single submit, reload, secret clearing, disable/cancel, failed verification, expired identity, mobile; synthetic providers only');
} finally { await browser?.close(); await f.close(); }
