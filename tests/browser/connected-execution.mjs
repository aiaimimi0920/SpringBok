import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready, configureService, reviewService } from './service-fixture.mjs';
const suite = await serviceBrowser(), { page, input, resource, state, machine, receipt, auth, errors } = suite;
try {
  await ready(page); await configureService(page, input, resource); await reviewService(page);
  assert.match(await page.locator('#service-review').textContent(), /test-database/); assert.equal(await page.locator('#service-submit').isDisabled(), false);
  await page.locator('#service-back').click(); assert.equal(state.dispatches, 0); await reviewService(page);
  await page.locator('#service-submit').evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !document.getElementById('service-dialog').open); assert.equal(state.dispatches, 1);
  await ready(page); await page.getByText('等待执行', { exact: true }).waitFor();
  assert.equal((await machine('source')).status, 200); const permit = await machine(); assert.equal(permit.status, 200); receipt(await permit.json());
  await ready(page); await page.getByText('部署成功', { exact: true }).waitFor(); assert.equal(state.dispatches, 1);
  await page.getByRole('button', { name: '详情', exact: true }).click();
  assert.equal(await page.getByRole('link', { name: 'GitHub Actions' }).getAttribute('href'), 'https://github.com/owner/executor/actions/runs/456');
  const dir = process.env.DEPLOYMENT_EVIDENCE_DIR ?? 'test-results'; await mkdir(dir, { recursive: true }); await page.screenshot({ path: join(dir, 'connected-execution-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: join(dir, 'connected-execution-mobile.png'), fullPage: true });
  auth.token = 'invalid'; await page.evaluate(() => dispatchEvent(new Event('visibilitychange'))); await page.getByText('身份验证失败，请重新登录', { exact: true }).waitFor();
  assert.equal(await page.locator('#service-list > li').count(), 0); assert.equal(await page.locator('#service-submit').isDisabled(), true); assert.deepEqual(errors, []);
  console.log('PASS Chrome + workerd connected execution: plan/back, one dispatch, reload instance index, exact OIDC source/permit and verified receipt, run link, identity cleanup and mobile; synthetic providers');
} finally { await suite.close(); }
