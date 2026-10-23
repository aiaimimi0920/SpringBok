import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createLab } from '../../src/contract.mjs';
import { replay } from '../../src/demo/store.mjs';
import { fixturePreview } from '../../src/preview/fixtures.mjs';
import { catalog, image } from '../helpers/execution.mjs';

// 真实静态页面/控制器 + 合成只读状态；不绕过 Linux 持久化保护，不启动执行器。
const output = process.env.UI_EVIDENCE_DIR;
if (output) await mkdir(output, { recursive: true });
const data = catalog(), lab = replay([]).lab;
lab.dispatch({ service: 'gateway', operation: 'test', params: {} }, { id: 'ui-fixture', role: 'human' });
lab.dispatch({ service: 'gateway', operation: 'test-result', params: { success: false } }, { id: 'ui-runner', role: 'runner' });
const demo = {
  csrf: 'ui-fixture', revision: 0, services: lab.snapshot().services, history: [], bindings: {},
  demoVersions: Object.fromEntries(lab.snapshot().services.map(row => [row.spec.id, { candidate: 'v1', active: null }])),
};
const consoleState = {
  csrf: 'ui-fixture', revision: 0, services: createLab(data.manifest).snapshot().services,
  requests: [], history: [], preparation: [], preparationHistory: [], bindings: {},
  versions: { v1: image(1), v2: image(2), bad: image(3) },
};
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
try {
  for (const mode of ['demo', 'test-console']) {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const errors = [], writes = [];
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin, 'https://local-ui.test');
      if (url.pathname === '/api/state') return route.fulfill({ json: mode === 'demo' ? demo : consoleState });
      if (mode === 'demo' && url.pathname === '/api/plan') {
        const q = url.searchParams;
        return route.fulfill({ json: fixturePreview(q.get('service'), q.get('scenario'), q.get('operation')) });
      }
      if (mode === 'test-console' && url.pathname === '/api/preview') {
        const body = req.postDataJSON(), release = data.releases.find(row => row.service === body.service);
        return route.fulfill({ json: { ...body, plan: { name: release.test.name, target: release.test.id,
          artifact: release.artifact, configDigest: 'synthetic', targetConfigDigest: 'synthetic' } } });
      }
      if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ status: 403 }); }
      const paths = new Map([
        ['/', `${mode}/index.html`], ['/style.css', `${mode}/style.css`], ['/app.js', `${mode}/app.js`],
        ['/preview.js', 'demo/preview.js'], ['/history.mjs', 'test-console/history.mjs'],
        ['/neuro.css', 'cloud-admin/tokens.css'], ['/local-neuro.css', 'local-neuro.css'],
      ]);
      const path = paths.get(url.pathname);
      assert.ok(path, url.pathname);
      return route.fulfill({ body: await readFile(new URL(`../../public/${path}`, import.meta.url)),
        contentType: path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript' });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://local-ui.test/');
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('.card').count(), 4);
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(6, 8, 13)');
    assert.equal(await page.locator('.card').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(14, 18, 24)');
    assert.equal(await page.locator('.history ol').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(17, 23, 32)');
    for (const width of [1280, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode}: ${width}`);
      if (output && [1280, 390].includes(width)) await page.screenshot({ path: join(output, `${mode}-${width}.png`), fullPage: true });
    }
    await page.locator('#refresh').focus();
    assert.equal(await page.locator('#refresh').evaluate(el => getComputedStyle(el).outlineColor), 'rgb(217, 255, 56)');
    if (mode === 'demo') {
      await page.locator('#preview-result dl').waitFor();
      assert.equal(await page.locator('.details dd').first().evaluate(el => getComputedStyle(el).color), 'rgb(247, 248, 239)');
      assert.equal(await page.locator('.phase.bad').evaluate(el => getComputedStyle(el).color), 'rgb(244, 63, 94)');
    } else {
      await page.getByRole('button', { name: '执行真实测试', exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector('#review-submit').disabled);
      assert.equal(await page.locator('#execution-review').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(14, 18, 24)');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#execution-review').isVisible(), false);
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    await context.close();
  }
  console.log('PASS local Neuro UI: actual demo/test-console assets/controllers, synthetic read states, 4 widths, panels/history/error/focus/dialog Escape, zero mutations; Linux persistence/execution NOT tested');
} finally { await browser.close(); }
