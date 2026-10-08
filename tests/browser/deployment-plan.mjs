import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready, configureService, reviewService } from './service-fixture.mjs';
const suite = await serviceBrowser(), { f, page, input, resource, auth, errors, state } = suite;
try {
  f.bindings.ENABLE_CONNECTED_DEPLOYMENTS = 'no'; await f.restart();
  await ready(page, '/deploy'); await configureService(page, input, resource); await reviewService(page);
  assert.match(await page.locator('#service-review').textContent(), /test-database/); assert.equal(await page.locator('#service-submit').isDisabled(), true);
  const dir = process.env.DEPLOYMENT_EVIDENCE_DIR ?? 'test-results'; await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, 'deployment-plan-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(dir, 'deployment-plan-mobile.png') });
  await page.locator('#service-back').click(); assert.equal(await page.locator('#service-review').isVisible(), false);
  await page.getByLabel('Worker 名称', { exact: true }).fill('changed'); await reviewService(page);
  assert.match(await page.locator('#service-review').textContent(), /testing/); await page.locator('#service-back').click();
  auth.token = 'invalid'; await page.locator('#service-submit').click(); await page.getByText('身份验证失败，请重新登录', { exact: true }).waitFor();
  assert.equal(await page.locator('#service-inputs').textContent(), ''); assert.equal(await page.locator('#service-submit').isDisabled(), true);
  assert.deepEqual(errors, []); assert.equal(state.dispatches, 0);
  console.log('PASS Chrome + workerd declaration-driven plan: discovered fixed SHA, generated fields, selected resource registration, review/back/edit invalidation, disabled execution, expired identity and mobile; no dispatch');
} finally { await suite.close(); }
