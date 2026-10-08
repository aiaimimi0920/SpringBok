import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture } from '../cloud/service-fixture.mjs';
import { configureService, reviewService, ready } from './service-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';

// Actual pages + workerd, synthetic identity/providers. No production access.
const { f, input, resource } = await serviceFixture();
let browser;
try {
  let token = f.jwt(), writes = 0;
  const directory = process.env.UI_EVIDENCE_DIR ?? 'test-results';
  await mkdir(directory, { recursive: true });
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const req = route.request(); assert.equal(new URL(req.url()).origin, origin);
    if (req.method() === 'POST' && !['inventory', 'usage'].includes(req.postDataJSON()?.action)) writes++;
    const response = await f.mf.dispatchFetch(req.url(), { method: req.method(), headers: { ...req.headers(), 'cf-access-jwt-assertion': token }, ...(req.postData() === null ? {} : { body: req.postData() }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const pages = [['/history', null, '#notice'], ['/settings', '连接设置', '#connection-status'], ['/resources', '云资源', '#resource-notice'], ['/services', '服务', '#service-loading']];
  for (const [path, label, status] of pages) {
    await page.goto(origin + path);
    await page.waitForFunction(id => !/正在验证|正在读取|读取持久记录|读取连接…/.test(document.querySelector(id).textContent), status);
    await page.locator('.brand svg').waitFor();
    assert.equal(await page.locator('.field-note, .section-note, .legacy-note, #connection-help, #connection-secret-help').count(),0,'No explanatory UI panels');
    if(label)assert.equal(await page.locator('nav a[aria-current=page]').textContent(), label);
    else assert.equal(await page.locator('nav a[aria-current=page]').count(),0);
    assert.equal(await page.locator('nav a').count(),3);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--neuro-signal-yellow').trim()), '#d9ff38');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(6, 8, 13)');
    assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).overflowY), 'auto');
    for (const width of [1440, 960, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, path + ': ' + width);
      if (width === 1440 || width === 390) await page.screenshot({ path: join(directory, `neuro-${path.slice(1) || 'history'}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  assert.equal(writes, 0, 'Layout/navigation must never trigger mutations');
  await page.goto(origin + '/settings'); await page.getByText('连接已刷新', { exact: true }).waitFor();
  assert.equal(await page.locator('.skip-link').evaluate(el => getComputedStyle(el).clipPath), 'inset(50%)');
  await page.locator('.skip-link').focus();
  assert.equal(await page.locator('.skip-link').evaluate(el => getComputedStyle(el).clipPath), 'none');
  await page.keyboard.press('Enter'); assert.equal(await page.locator('main').evaluate(el => el === document.activeElement), true);
  await page.locator('#connection-name').focus();
  assert.equal(await page.locator('#connection-name').evaluate(el => getComputedStyle(el).outlineColor), 'rgb(217, 255, 56)');
  const button = page.locator('#connections-list li').first().getByRole('button', { name: '停用', exact: true });
  await button.click(); assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).overflowY), 'hidden');
  assert.equal(await page.locator('#connection-disable-cancel').evaluate(el => el === document.activeElement), true);
  await page.screenshot({ path: join(directory, 'neuro-dialog.png') });
  await page.keyboard.press('Escape'); assert.equal(await button.evaluate(el => el === document.activeElement), true);
  assert.equal(writes, 0);
  token = 'invalid'; await page.locator('#connections-refresh').click();
  await page.getByText('身份验证失败，请重新登录', { exact: true }).waitFor();
  assert.equal(await page.locator('#connection-status').getAttribute('data-tone'), 'error');
  assert.equal(await page.locator('#connection-save').isDisabled(), true);
  assert.equal(await page.locator('#connection-save').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(9, 12, 17)');
  await page.screenshot({ path: join(directory, 'neuro-auth-error.png') });
  token = f.jwt(); await ready(page); await configureService(page,input,resource); await reviewService(page);
  assert.equal(await page.locator('.service-form-scroll').evaluate(el => getComputedStyle(el).overflowY), 'auto');
  await page.screenshot({ path: join(directory, 'neuro-deployment-review.png') });
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  console.log('PASS Neuro UI: four actual pages, 5 widths, canonical colors, focus, Escape/restore, dialog scroll lock, error/disabled, plan, no implicit writes; synthetic providers');
} finally { await browser?.close(); await f.close(); }
