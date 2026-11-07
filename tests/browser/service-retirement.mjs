import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceBrowser, ready } from './service-fixture.mjs';
import { configurePreviewFixture } from '../cloud/preview-fixture.mjs';
import { configureSuiteFixture } from '../cloud/suite-fixture.mjs';

const s = configureSuiteFixture(configurePreviewFixture(await serviceBrowser()));
const directory = process.env.UI_EVIDENCE_DIR ?? 'test-results'; await mkdir(directory, { recursive: true });
try {
  const first = (await s.service('plan', s.input)).json(); await s.submit(first); s.complete(await (await s.machine()).json());
  await s.service('service-state', { instanceId: first.taskId, reconcile: true });
  const previous = s.state.provider; let present = false;
  s.state.provider = async (request, context) => {
    const url = new URL(request.url);
    if (url.pathname.includes('/d1/database/') && request.method === 'GET') return Response.json(present ? { success: true, errors: [], result: { uuid: s.state.created[0].id, name: 'testing-db' } } : { success: false, errors: [{ code: 7404 }], result: null }, { status: present ? 200 : 404 });
    if (url.pathname.endsWith('/workers/scripts')) return Response.json({ success: true, result: [] });
    if (url.pathname.endsWith('/pages/projects/testing-pages')) return Response.json({ success: false, result: null, errors: [{ code: 8000007 }] }, { status: 404 });
    if (url.pathname.endsWith('/environments')) return Response.json({ total_count: 0, environments: [] });
    if (url.pathname.includes('/actions/workflows/') && url.pathname.endsWith('/runs')) return Response.json({ total_count: 0, workflow_runs: [] });
    return previous(request, context);
  };
  const { page } = s; await ready(page);
  const retire = page.getByRole('button', { name: '退役登记', exact: true });
  await retire.evaluate(button => { button.click(); button.click(); });
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: '确认退役登记' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button')].some(b => b.textContent === '确认退役登记' && !b.disabled));
  assert.equal(s.requests.filter(row => row.path.endsWith('/retire-plan')).length, 1);
  assert.match(await dialog.textContent(), /testing-pages.*已不存在/);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(directory, `retirement-${width}.png`) });
  }
  await dialog.evaluate(el => { window.retirementClosed = false; el.addEventListener('close', () => { window.retirementClosed = true; }, { once: true }); });
  await page.keyboard.press('Escape'); await page.waitForFunction(() => window.retirementClosed === true);
  assert.equal(await retire.evaluate(el => el === document.activeElement), true);
  present = true; await retire.click(); await page.getByText('无法证明资源均已不存在，请检查资源状态与连接权限', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认退役登记' }).isDisabled(), true);
  await dialog.evaluate(el => { window.retirementClosed = false; el.addEventListener('close', () => { window.retirementClosed = true; }, { once: true }); });
  await page.getByRole('button', { name: '取消', exact: true }).click(); await page.waitForFunction(() => window.retirementClosed === true);
  present = false; await retire.click(); await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button')].some(b => b.textContent === '确认退役登记' && !b.disabled));
  await page.getByRole('button', { name: '确认退役登记' }).focus(); await page.keyboard.press('Enter');
  await page.getByText('旧服务登记已退役', { exact: true }).waitFor(); await page.locator('[data-instance-id]').waitFor({ state: 'detached' });
  assert.equal(s.state.dispatches, 1); assert.equal(s.requests.filter(row => row.path.endsWith('/retire-submit')).length, 1);
  await ready(page); assert.equal(await retire.count(), 0); assert.deepEqual(s.errors, []);
  assert.equal((await s.service('service-state', { instanceId: first.taskId, reconcile: false })).json().history.length, 1);
  console.log('Service retirement UI passed: absent-only signed review, duplicate click, cancel/focus, refusal, keyboard, narrow screens and persisted active-list removal (synthetic providers).');
} finally { await s.close(); }
