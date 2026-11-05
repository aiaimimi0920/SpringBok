import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
import { r2DeletionFixture, bucketNames } from '../cloud/service-deletion-r2-fixture.mjs';

const browser = await serviceBrowser();
try {
  const s = await r2DeletionFixture(browser), { page } = s;
  const directory = process.env.UI_EVIDENCE_DIR ?? 'test-results';
  await mkdir(directory, { recursive: true });
  await ready(page);
  const remove = page.getByRole('button', { name: '删除', exact: true });
  await remove.click();
  await page.locator('#service-delete-submit').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('service-delete-submit').disabled);
  const inventory = await page.locator('#service-delete-resources').textContent();
  for (const name of bucketNames) assert.ok(inventory.includes(name));
  assert.match(inventory, /1 对象 · 12 B/); assert.match(inventory, /0 对象 · 0 B/);
  assert.ok(!inventory.includes('private/message.eml')); assert.equal(s.live.deletes.length, 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `service-delete-r2-${width}.png`) });
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('service-delete-dialog').open);
  assert.equal(s.live.deletes.length, 0);
  assert.equal(await remove.evaluate(el => el === document.activeElement), true);
  await remove.click(); await page.waitForFunction(() => !document.getElementById('service-delete-submit').disabled);
  await page.locator('#service-delete-submit').click();
  await page.getByText('已删除', { exact: true }).waitFor();
  assert.equal(s.r2.objects.size, 0); assert.equal(s.live.deletes.length, 6);
  assert.equal(await remove.isDisabled(), true);
  await ready(page); await page.getByText('已删除', { exact: true }).waitFor();
  assert.equal(s.live.deletes.length, 6); assert.deepEqual(s.errors, []);
  console.log('R2 deletion UI passed: bounded private-object counts, exact two-bucket inventory, cancel/focus, responsive layout and persisted result (synthetic providers).');
} finally { await browser.close(); }
