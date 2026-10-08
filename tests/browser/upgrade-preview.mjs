import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready, reviewService } from './service-fixture.mjs';
import { configurePreviewFixture } from '../cloud/preview-fixture.mjs';
import { updatedSha } from '../cloud/service-fixture.mjs';

const suite = configurePreviewFixture(await serviceBrowser());
const { page, state, complete, machine, errors } = suite;
const directory = process.env.UI_EVIDENCE_DIR ?? 'test-results'; await mkdir(directory, { recursive: true });
const confirm = async () => {
  await page.waitForFunction(() => !document.getElementById('service-submit').disabled);
  await page.locator('#service-submit').evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => !document.getElementById('service-dialog').open);
};
const chooseVersion = async () => {
  await page.waitForFunction(sha => document.querySelector(`#service-version option[value="${sha}"]`), updatedSha);
  await page.locator('#service-version').selectOption(updatedSha);
  await page.waitForFunction(() => !document.getElementById('service-submit').disabled);
};
try {
  state.missingSba.add('owner/second');
  await ready(page); await page.locator('#service-add').click();
  await page.locator('[role=tab][data-repository="owner/repo"]').click();
  await reviewService(page); await confirm();
  const parentId = state.request.taskId, original = structuredClone(state.request.configuration);
  complete(await (await machine()).json()); await ready(page);
  const parent = page.locator(`[data-instance-id="${parentId}"]`);
  await parent.getByRole('button', { name: '预升级测试', exact: true }).click();
  await chooseVersion();
  assert.match(await page.locator('#service-environment').inputValue(), /^test-[a-f0-9]{12}$/);
  assert.equal(await page.locator('#service-environment').isDisabled(), true);
  await reviewService(page); assert.equal(state.dispatches, 1);
  await page.keyboard.press('Escape');
  assert.equal(await parent.getByRole('button', { name: '预升级测试', exact: true }).evaluate(el => el === document.activeElement), true);
  await parent.getByRole('button', { name: '预升级测试', exact: true }).click(); await chooseVersion(); await reviewService(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `upgrade-preview-review-${width}.png`) });
  }
  await confirm(); assert.equal(state.dispatches, 2); assert.equal(state.created.length, 2);
  const previewId = state.request.taskId, isolated = structuredClone(state.request.configuration);
  assert.notEqual(isolated.database.id, original.database.id);
  assert.deepEqual(state.request.context.source.configuration, original);
  complete(await (await machine()).json()); await ready(page);
  const preview = page.locator(`[data-instance-id="${previewId}"]`);
  assert.equal(await preview.getByRole('link', { name: '测试地址', exact: true }).getAttribute('href'), isolated.url);
  assert.equal(await preview.getByRole('button', { name: '升级', exact: true }).count(), 0);
  await page.screenshot({ path: join(directory, 'upgrade-preview-instances-320.png') });
  await parent.getByRole('button', { name: '升级', exact: true }).click(); await chooseVersion(); await reviewService(page); await confirm();
  assert.equal(state.dispatches, 3); assert.equal(state.created.length, 2);
  assert.equal(state.request.action, 'update'); assert.deepEqual(state.request.configuration, original);
  complete(await (await machine()).json()); await ready(page);
  await preview.getByRole('button', { name: '删除测试环境', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('service-submit').disabled);
  assert.equal(await page.locator('#service-close').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#service-fields').evaluate(el => el.disabled), true);
  assert.match(await page.locator('#service-review').textContent(), /永久删除/);
  assert.doesNotMatch(await page.locator('#service-review').textContent(), new RegExp(original.database.id));
  await page.screenshot({ path: join(directory, 'upgrade-preview-delete-320.png') });
  await page.keyboard.press('Escape'); assert.equal(state.dispatches, 3);
  await preview.getByRole('button', { name: '删除测试环境', exact: true }).click(); await confirm();
  assert.equal(state.dispatches, 4); assert.equal(state.request.action, 'destroy-preview');
  assert.equal(Object.hasOwn(state.request.context, 'source'), false);
  complete(await (await machine()).json()); await ready(page);
  assert.match(await preview.textContent(), /已删除/); assert.equal(await preview.getByRole('link', { name: '测试地址', exact: true }).count(), 0);
  assert.equal(await preview.getByRole('button', { name: '删除测试环境', exact: true }).isDisabled(), true);
  assert.match(await parent.textContent(), /v2\.0\.0/); assert.equal(state.created.length, 2);
  assert.deepEqual(errors, []);
  console.log('Upgrade preview, retained production update and scoped cleanup passed (synthetic providers, actual Chrome/workerd).');
} finally { await suite.close(); }

// 独立失败实例：unknown 不能靠测试回执改回成功，也不能自动重新清理。
const failure = configurePreviewFixture(await serviceBrowser());
try {
  const first = (await failure.service('plan', failure.input)).json();
  assert.equal((await failure.submit(first)).status, 200);
  failure.complete(await (await failure.machine()).json());
  await failure.service('service-state', { instanceId: first.taskId, reconcile: true });
  const plan = (await failure.service('plan', { action: 'rehearse', instanceId: first.taskId, previousTaskId: first.taskId, sourceSha: updatedSha, environment: 'test-123456789abc' })).json();
  assert.equal((await failure.submit(plan)).status, 200);
  failure.complete(await (await failure.machine()).json()); await ready(failure.page);
  const row = failure.page.locator(`[data-instance-id="${plan.taskId}"]`);
  await row.getByRole('button', { name: '删除测试环境', exact: true }).click();
  await failure.page.waitForFunction(() => !document.getElementById('service-submit').disabled);
  await failure.page.locator('#service-submit').click();
  await failure.page.waitForFunction(() => !document.getElementById('service-dialog').open);
  failure.complete(await (await failure.machine()).json(), 'unknown', { lifecycle: { resources: failure.state.request.context.resources.map((item, index) => ({ key: item.key, status: index ? 'unknown' : 'removed' })) } });
  await ready(failure.page);
  assert.match(await row.textContent(), /清理结果未确认/); assert.doesNotMatch(await row.textContent(), /已删除/);
  assert.equal(await row.getByRole('button', { name: '删除测试环境', exact: true }).isDisabled(), true);
  assert.equal(await row.getByRole('link', { name: '测试地址', exact: true }).count(), 0);
  failure.auth.intercept = async route => {
    if (!route.request().url().endsWith('/service-state')) return false;
    await route.fulfill({ status: 503, body: '{}' }); return true;
  };
  await failure.page.evaluate(() => dispatchEvent(new Event('visibilitychange')));
  await failure.page.waitForFunction(() => document.getElementById('service-notice').textContent.includes('未确认'));
  const parent = failure.page.locator(`[data-instance-id="${first.taskId}"]`);
  await failure.page.waitForFunction(id => document.querySelector(`[data-focus-key="${id}/preview"]`).disabled, first.taskId);
  assert.equal(await parent.getByRole('button', { name: '升级', exact: true }).isDisabled(), true);
  assert.equal(failure.state.dispatches, 3); assert.deepEqual(failure.errors, []);
  console.log('Unknown cleanup and stale read failure remain disabled without replay (synthetic providers).');
} finally { await failure.close(); }
