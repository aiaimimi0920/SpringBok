import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
import { deletionProvider } from '../cloud/service-deletion-fixture.mjs';

const s = await serviceBrowser(), { page, service, input, submit, machine, receipt, errors } = s;
const directory = process.env.UI_EVIDENCE_DIR ?? 'test-results'; await mkdir(directory, { recursive: true });
try {
  const initial = (await service('plan', input)).json(); await submit(initial); receipt(await (await machine()).json());
  await service('service-state', { instanceId: initial.taskId, reconcile: true }); const live = deletionProvider(s);
  await ready(page); const remove = page.getByRole('button', { name: '删除', exact: true });
  await remove.click(); await page.waitForFunction(() => !document.getElementById('service-delete-submit').disabled);
  assert.match(await page.locator('#service-delete-resources').textContent(), /test-worker/);
  assert.match(await page.locator('#service-delete-resources').textContent(), /test-database/);
  assert.equal(live.deletes.length, 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `service-delete-${width}.png`) });
  }
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('service-delete-dialog').open);
  assert.equal(await remove.evaluate(el => el === document.activeElement), true); assert.equal(live.deletes.length, 0);
  live.shared = true; await remove.click(); await page.getByText('无法确认独占资源清单，请检查共享绑定、资源变更或连接权限', { exact: true }).waitFor();
  assert.equal(await page.locator('#service-delete-submit').isDisabled(), true); await page.locator('#service-delete-close').click(); live.shared = false;
  await remove.click(); await page.waitForFunction(() => !document.getElementById('service-delete-submit').disabled);
  await page.locator('#service-delete-submit').click(); await page.waitForFunction(() => !document.getElementById('service-delete-dialog').open);
  await page.getByText('已删除', { exact: true }).waitFor(); assert.equal(live.deletes.length, 3);
  assert.equal(await remove.isDisabled(), true); assert.equal(await page.getByRole('button', { name: '升级', exact: true }).isDisabled(), true);
  await ready(page); await page.getByText('已删除', { exact: true }).waitFor(); assert.equal(live.deletes.length, 3); assert.deepEqual(errors, []);
  console.log('Service deletion UI passed: exact inventory, cancel/focus, shared-resource rejection, responsive confirmation, persisted result (synthetic providers).');
} finally { await s.close(); }
