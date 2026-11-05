import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
import { emailRoutingFixture } from '../cloud/email-routing-fixture.mjs';
import { deletionProvider } from '../cloud/service-deletion-fixture.mjs';

const browser = await serviceBrowser();
try {
  const s = await emailRoutingFixture(browser), { page } = s;
  const directory = process.env.UI_EVIDENCE_DIR ?? 'test-results'; await mkdir(directory, { recursive: true });
  await s.deploy(); const live = deletionProvider(s); await ready(page);
  const remove = page.getByRole('button', { name: '删除', exact: true });
  await remove.click(); await page.waitForFunction(() => !document.getElementById('service-delete-submit').disabled);
  const text = await page.locator('#service-delete-resources').textContent();
  assert.match(text, /收信路由/); assert.match(text, /example\.invalid/); assert.match(text, /→ test-worker/); assert.ok(!text.includes('undefined'));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `email-routing-delete-${width}.png`) });
  }
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('service-delete-dialog').open);
  assert.equal(await remove.evaluate(el => el === document.activeElement), true);
  assert.equal(s.live.writes.filter(row => row.method === 'PUT').length, 0); assert.equal(live.deletes.length, 0);
  await remove.click(); await page.waitForFunction(() => !document.getElementById('service-delete-submit').disabled);
  await page.locator('#service-delete-submit').click(); await page.getByText('已删除', { exact: true }).waitFor();
  assert.equal(s.live.rule.enabled, false); assert.equal(s.live.writes.filter(row => row.method === 'PUT').length, 1); assert.equal(live.deletes.length, 3);
  await ready(page); await page.getByText('已删除', { exact: true }).waitFor();
  assert.equal(s.live.writes.filter(row => row.method === 'PUT').length, 1); assert.deepEqual(s.errors, []);
  console.log('Email Routing UI passed: exact root-domain/receiving Worker inventory, cancel/focus, three viewport widths and persisted single-attempt unbinding (synthetic providers).');
} finally { await browser.close(); }
