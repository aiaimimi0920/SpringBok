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
  live.pagesDeployments = [{ id: '87654321-1234-1234-1234-123456789abc', uses_functions: true, kv_namespaces: {} }];
  await remove.click(); await page.locator('#service-delete-risk-label').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#service-delete-submit').isDisabled(), true);
  await page.locator('#service-delete-risk').check(); assert.equal(await page.locator('#service-delete-submit').isEnabled(), true);
  assert.match(await page.locator('#service-delete-resources').textContent(), /test-worker/);
  assert.match(await page.locator('#service-delete-resources').textContent(), /test-database/);
  assert.equal(live.deletes.length, 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `service-delete-${width}.png`) });
  }
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('service-delete-dialog').open);
  assert.equal(await remove.evaluate(el => el === document.activeElement), true); assert.equal(live.deletes.length, 0);
  live.shared = true; await remove.click(); await page.getByText('无法核对删除清单，请检查共享绑定、资源变更或连接权限', { exact: true }).waitFor();
  assert.equal(await page.locator('#service-delete-submit').isDisabled(), true); await page.locator('#service-delete-close').click(); live.shared = false;
  await remove.click(); await page.locator('#service-delete-risk-label').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#service-delete-submit').isDisabled(), true);
  await page.locator('#service-delete-risk').check();
  await page.locator('#service-delete-submit').click(); await page.waitForFunction(() => !document.getElementById('service-delete-dialog').open);
  await page.locator('#service-empty').waitFor({ state: 'visible' }); assert.equal(live.deletes.length, 3);
  assert.equal(await page.locator('#service-list > li').count(), 0);
  await ready(page); await page.locator('#service-empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#service-list > li').count(), 0);
  const deleted = (await service('service-state', { instanceId: initial.taskId, reconcile: false })).json();
  assert.equal(deleted.status, 'deleted'); assert.equal(deleted.history.length, 1);
  assert.equal(live.deletes.length, 3); assert.deepEqual(errors, []);
  console.log('Service deletion UI passed: exact inventory, cancel/focus, shared-resource rejection, responsive confirmation, persisted result (synthetic providers).');
} finally { await s.close(); }

const recovery = await serviceBrowser();
try {
  const { page, service, input, submit, machine, receipt, requests, errors } = recovery;
  const initial = (await service('plan', input)).json(); await submit(initial); receipt(await (await machine()).json());
  await service('service-state', { instanceId: initial.taskId, reconcile: true });
  const live = deletionProvider(recovery), review = (await service('delete-plan', { instanceId: initial.taskId, previousTaskId: initial.taskId })).json();
  live.lost = true;
  assert.equal((await service('delete-submit', { ...review, acceptUnverifiedReferences: false })).json().status, 'delete-unknown');
  await ready(page); const check = page.getByRole('button', { name: '核对删除结果', exact: true });
  await check.evaluate(button => { button.click(); button.click(); });
  await page.getByText('删除结果仍未确认', { exact: true }).waitFor();
  await check.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '核对删除结果' && !button.disabled));
  assert.equal(requests.filter(row => row.path.endsWith('/delete-reconcile')).length, 1);
  assert.equal(live.database, true); assert.equal(live.deletes.length, 2);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `service-delete-reconcile-${width}.png`) });
  }
  live.database = false; await check.focus(); await page.keyboard.press('Enter');
  await page.locator('#service-empty').waitFor({ state: 'visible' }); assert.equal(await check.count(), 0);
  assert.equal(await page.locator('#service-add').evaluate(button => button === document.activeElement), true);
  await ready(page); await page.locator('#service-empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#service-list > li').count(), 0);
  const deleted = (await service('service-state', { instanceId: initial.taskId, reconcile: false })).json();
  assert.equal(deleted.status, 'deleted'); assert.equal(deleted.history.length, 1);
  assert.equal(live.deletes.length, 2); assert.deepEqual(errors, []);
  console.log('Deletion reconciliation UI passed: one read-only check per double click, unknown while present, original inventory absent, history retained (synthetic providers).');
} finally { await recovery.close(); }

const visibility = await serviceBrowser();
try {
  const { page, service, input, submit, machine, receipt, auth, requests, errors } = visibility;
  const initial = (await service('plan', input)).json(); await submit(initial); receipt(await (await machine()).json());
  const confirmed = (await service('service-state', { instanceId: initial.taskId, reconcile: true })).json();
  let shownStatus;
  auth.intercept = async route => {
    if (!route.request().url().endsWith('/service-state')) return false;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...confirmed, status: shownStatus }) });
    return true;
  };
  const row = page.locator(`[data-instance-id="${initial.taskId}"]`);
  for (const status of ['succeeded', 'deleting', 'delete-unknown', 'failed', 'unknown', 'unavailable']) {
    shownStatus = status; await ready(page); await row.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#service-empty').isVisible(), false, status);
  }
  shownStatus = 'deleted'; requests.length = 0; await ready(page);
  await page.locator('#service-empty').waitFor({ state: 'visible' }); assert.equal(await row.count(), 0);
  assert.equal(requests.filter(row => row.path === '/api/admin/resources' && row.body?.action === 'usage').length, 0);
  assert.equal((await service('state', { taskId: initial.taskId })).json().job.status, 'succeeded');
  assert.deepEqual(errors, []);
  console.log('Service list visibility passed: only confirmed deleted is hidden; active, unknown and failed states remain; no deleted resource usage reads.');
} finally { await visibility.close(); }
