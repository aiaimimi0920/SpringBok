import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { startConfigReview } from '../../src/config/server.mjs';
import { compileConfiguration } from '../../src/config/compile.mjs';
const source = JSON.parse(readFileSync(new URL('../../examples/config/services.json', import.meta.url)));
const file = (value, name = 'services.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
const app = await startConfigReview(); let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [], requests = [], downloads = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  page.on('download', download => downloads.push(download));
  await page.goto(app.origin);
  const input = page.getByLabel('JSON文件 · UTF-8 · 最大64KiB');
  const download = page.getByRole('button', { name: '下载校验草稿', exact: true });
  await page.waitForFunction(() => !document.querySelector('#config-file').disabled);
  const ready = async value => { await input.setInputFiles(file(value)); await page.getByText('输入校验通过；仍需核对下列未完成项。尚未连接或部署', { exact: true }).waitFor(); };
  await ready(source); assert.equal(await page.locator('article').count(), 4); assert.equal(await download.isEnabled(), true);
  assert.equal(downloads.length, 0);
  const event = page.waitForEvent('download'); await download.click(); const saved = await event;
  assert.equal(saved.suggestedFilename(), 'springbok-review.json');
  const chunks = []; for await (const chunk of await saved.createReadStream()) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), compileConfiguration(source));
  // Invalid replacement revokes the old valid export before displaying an error.
  await input.setInputFiles(file({ PRIVATE: 'DO_NOT_ECHO' }));
  await page.getByText('manifest: unexpected or missing fields', { exact: true }).waitFor();
  assert.equal(await download.isDisabled(), true); assert.equal(await page.locator('#result').isVisible(), false);
  assert.ok(!(await page.textContent('body')).includes('DO_NOT_ECHO'));
  const countBeforeOversize = requests.filter(r => r.method === 'POST').length;
  await input.setInputFiles({ name: 'too-big.json', mimeType: 'application/json', buffer: Buffer.alloc(65537, 32) });
  await page.getByText('文件超过64KiB', { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.method === 'POST').length, countBeforeOversize);
  await ready(source);
  await input.dispatchEvent('cancel'); // Native file-input cancellation event semantics.
  assert.equal(await download.isDisabled(), true); assert.equal(await page.locator('#result').isVisible(), false);
  await ready(source); await page.getByRole('button', { name: '清空', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.equal(await download.isDisabled(), true);
  // A replaced/aborted request can finish late but must never restore old output.
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const arrived = new Promise(resolve => { entered = resolve; });
  let first = true;
  await page.route('**/api/validate', async route => {
    if (!first) return route.continue(); first = false; entered(); await gate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(compileConfiguration(source)) });
  });
  await input.setInputFiles(file(source)); await arrived;
  const second = structuredClone(source); second.project = 'replacement'; second.services = [second.services[0]];
  await ready(second); release(); await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await page.locator('#overview dd').first().textContent(), 'replacement');
  assert.equal(await page.locator('article').count(), 1);
  await page.evaluate(() => history.pushState({}, '', '/#checked'));
  await page.goBack(); assert.equal(await download.isDisabled(), true); assert.equal(await page.locator('#result').isVisible(), false);
  await page.goForward(); assert.equal(await download.isDisabled(), true);
  await ready(second); await ready(second); assert.equal(await page.locator('article').count(), 1);
  assert.equal(downloads.length, 1); // No replacement/reset/navigation auto-download.
  // Two real sample services keep the screenshot readable and show both data and ports.
  const display = structuredClone(source); display.services = display.services.slice(0, 2);
  await ready(display); mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/config-review-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/config-review-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  for (const request of requests) {
    const url = new URL(request.url); assert.equal(url.origin, app.origin);
    assert.ok(['/', '/app.js', '/style.css', '/api/session', '/api/validate'].includes(url.pathname));
    if (request.method !== 'GET') assert.deepEqual({ method: request.method, path: url.pathname }, { method: 'POST', path: '/api/validate' });
  }
  console.log('PASS config UI: shared compiler, explicit download, invalid replacement revocation, oversize, cancel/reset/keyboard/late replacement/Back/Forward/repeat/390px and loopback-only requests; no deployment or credentials');
} finally { await browser?.close(); await app.close(); }
