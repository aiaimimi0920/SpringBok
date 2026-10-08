import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sbaFixture, policy, sha, sourceSha } from '../cloud/sba-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';
import { zip } from '../sba-zip-fixture.mjs';
const cleanup = [], x = await sbaFixture({ after: fn => cleanup.push(fn) });
let active = x;
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } }), errors = [], paths = [];
  await context.route('**/*', async route => {
    const request = route.request(); assert.equal(new URL(request.url()).origin, origin); paths.push(new URL(request.url()).pathname);
    const response = await active.f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': active.session },
      ...(request.postData() === null ? {} : { body: request.postData() }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/history'); await page.locator('#sba-panel').waitFor().catch(async error => { throw new Error(JSON.stringify({ errors, paths, text: await page.locator('body').textContent(), cause: error.message })); });
  const start = page.locator('#sba-start'); await start.click(); await page.locator('#sba-confirm').waitFor();
  await page.locator('#sba-cancel').click(); assert.equal(x.state.dispatches, 0);
  await start.click(); await page.locator('#sba-confirm').waitFor(); await page.keyboard.press('Escape'); assert.equal(x.state.dispatches, 0);
  await start.click(); await page.locator('#sba-confirm').waitFor(); await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate')));
  assert.equal(await page.locator('#sba-confirm').isVisible(), false);
  await start.click(); await page.locator('#sba-confirm').waitFor();
  assert.match(await page.locator('#sba-plan').textContent(), new RegExp(sourceSha));
  const directory = process.env.SBA_EVIDENCE_DIR ?? 'test-results'; await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, 'sba-synthetic-confirm-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#sba-submit').evaluate(button => { button.click(); button.click(); });
  await page.getByText('提交已记录', { exact: true }).waitFor();
  assert.equal(x.state.dispatches, 1); assert.equal(paths.filter(path => path === '/api/admin/sba/submit').length, 1);
  await page.reload(); await page.getByText('已读取持久记录', { exact: true }).waitFor();
  assert.equal(await start.isEnabled(), false); assert.equal(x.state.dispatches, 1);
  const allowed = await x.permit(); assert.equal(allowed.status, 200);
  const result = { schemaVersion: 2, taskId: allowed.value.request.taskId, action: 'deploy', sourceSha, applicationVersion: '1.0.0',
    status: 'succeeded', checks: [{ id: 'health-check', passed: true }] };
  x.state.archive = zip({ schemaVersion: 1, runId: 456, runAttempt: 1, executorSha: sha, requestDigest: allowed.value.requestDigest,
    permitId: allowed.value.permitId, result }); x.state.runStatus = 'completed';
  await page.locator('#refresh').click(); await page.getByText('已读取持久记录', { exact: true }).waitFor();
  await page.locator('#sba-reconcile').click(); await page.getByText('已核对 GitHub run 和可信回执', { exact: true }).waitFor();
  assert.match(await page.locator('#sba-record').textContent(), /应用报告检查通过/);
  assert.equal(await page.locator('#sba-reconcile').isEnabled(), false);
  assert.doesNotMatch(await page.locator('body').textContent(), /synthetic-deployment-secret|permitId|never-return/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); assert.equal(x.state.dispatches, 1);
  await page.screenshot({ path: join(directory, 'sba-synthetic-receipt-mobile.png'), fullPage: true });
  const y = await sbaFixture({ after: fn => cleanup.push(fn) }); active = y;
  await y.post('submit', await y.preview()); y.state.runStatus = 'completed'; y.state.conclusion = 'failure';
  const recovered = await y.post('recover-unstarted', { taskId: y.state.request.taskId, executorSha: 'f'.repeat(40) });
  assert.equal(recovered.status, 200);
  y.f.bindings.SBA_POLICY = JSON.stringify({ ...policy, github: { ...policy.github, executorSha: 'f'.repeat(40), ref: `sba-executor-${'f'.repeat(40)}` } });
  await y.f.restart(); await page.reload(); await page.getByText('已读取持久记录', { exact: true }).waitFor();
  assert.equal(await start.isEnabled(), true); assert.match(await page.locator('#sba-record').textContent(), /归档历史/);
  assert.match(await page.locator('#sba-record').textContent(), /"outcome": "not-executed"/);
  assert.match(await page.locator('#sba-record').textContent(), /sba-test-task/);
  assert.doesNotMatch(await page.locator('body').textContent(), /synthetic-deployment-secret|permitId|never-return/);
  assert.equal(y.state.dispatches, 1); assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'sba-synthetic-recovery-history-mobile.png'), fullPage: true });
  console.log('PASS real Chrome + workerd: SBA preview/cancel/escape/back, single submit, reload, OIDC permit and verified receipt (synthetic GitHub, no deployment)');
} finally { await browser?.close(); for (const fn of cleanup) await fn(); }
