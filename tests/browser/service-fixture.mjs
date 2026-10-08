import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { serviceFixture } from '../cloud/service-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';

export async function serviceBrowser() {
  const fixture = await serviceFixture(), { f } = fixture;
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), errors = [], requests = [];
  const auth = { token: f.jwt(), intercept: null };
  await context.route('**/*', async route => {
    const req = route.request(); assert.equal(new URL(req.url()).origin, origin);
    requests.push({ path: new URL(req.url()).pathname, method: req.method(), body: req.postData() ? req.postDataJSON() : null });
    if (await auth.intercept?.(route)) return;
    const response = await f.mf.dispatchFetch(req.url(), { method: req.method(), headers: { ...req.headers(), 'cf-access-jwt-assertion': auth.token }, ...(req.postData() === null ? {} : { body: req.postData() }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  return { ...fixture, browser, context, page, auth, errors, requests, close: async () => { await browser.close(); await f.close(); } };
}
export async function ready(page, path = '/services') {
  await page.goto(origin + path);
  await page.waitForFunction(() => document.getElementById('service-loading').textContent === '' && document.getElementById('service-notice').textContent === '');
}
export async function configureService(page, input, resource) {
  await page.locator('#service-add').click();
  const tab = page.locator('[role=tab][data-repository="owner/repo"]'); await tab.waitFor(); await tab.click();
  await page.locator('#service-cloudflare').selectOption(input.cloudflare.id);
  await page.locator('#service-environment').fill('testing');
  await page.locator('#service-resource-database').selectOption(resource.remoteId);
  await page.getByLabel('Worker 名称', { exact: true }).fill('test-worker');
}
export async function reviewService(page) {
  await page.locator('#service-submit').click();
  await page.waitForFunction(() => !document.getElementById('service-review').hidden);
}
