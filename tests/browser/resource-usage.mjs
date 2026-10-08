import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { usageFixture, databaseOne } from '../cloud/usage-fixture.mjs';
import { fakeToken } from '../cloud/connections-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';

const { f, state } = await usageFixture(); let browser;
try {
  let token = f.jwt(); const session = { token, headers: { 'x-csrf-token': (await f.call('/api/admin/state', { token })).json().csrf } };
  const add = async () => f.call('/api/admin/connections', { ...session, body: { action: 'connect', id: crypto.randomUUID(), name: '容量规划', provider: 'cloudflare', accountId: '', token: fakeToken } });
  assert.equal((await add()).status, 200); assert.equal((await add()).status, 200, 'A second credential for the same accounts is intentional');
  const writes = [], reads = [], errors = [], directory = process.env.UI_EVIDENCE_DIR ?? 'test-results';
  let blockedRequest;
  const holdRequest = matches => {
    let started, release;
    const observed = new Promise(resolve => { started = resolve; }), pending = new Promise(resolve => { release = resolve; });
    blockedRequest = { matches, started, pending };
    return { observed, release };
  };
  await mkdir(directory, { recursive: true });
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const request = route.request(); assert.equal(new URL(request.url()).origin, origin);
    const body = request.postData() ? request.postDataJSON() : null;
    if (body) (['inventory', 'usage'].includes(body.action) ? reads : writes).push(body.action);
    if (blockedRequest?.matches(request, body)) {
      const blocked = blockedRequest; blockedRequest = null; blocked.started(); await blocked.pending;
    }
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token }, ...(body ? { body: request.postData() } : {}) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const ready = () => page.waitForFunction(() => !document.getElementById('resource-fields').disabled && document.getElementById('resource-notice').textContent === '' && document.getElementById('resource-loading').textContent === '');
  const accountA = 'a'.repeat(32), accountB = 'b'.repeat(32);
  const group = (kind, account = accountA) => page.locator(`.inventory-group[data-kind="${kind}"][data-account="${account}"]`);
  const open = async locator => { if (!(await locator.evaluate(element => element.open))) await locator.locator(':scope > summary > .tree-label').click(); };
  const stats = locator => locator.locator(':scope > summary > .usage-metrics');
  const statsToggle = locator => locator.locator(':scope > summary > [data-stats]');
  const geometry = () => page.evaluate(() => Object.fromEntries(['.page-heading', '.resource-toolbar', '#resource-accounts'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect(); return [selector, [rect.x, rect.y, rect.width]];
  })));
  const initialRead = holdRequest(request => new URL(request.url()).pathname === '/api/admin/connections');
  await page.goto(origin + '/resources'); await initialRead.observed;
  const loadingLayout = new Map();
  for (const width of [1440, 960, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('#resource-loading').innerText(), '正在读取账户与云资源');
    assert.equal(await page.locator('.status-line').isVisible(), false, 'Routine loading never occupies the content notice');
    assert.equal(await page.locator('#resource-loading').evaluate(element => {
      const rect = element.getBoundingClientRect(), overlaps = target => {
        const other = target.getBoundingClientRect();
        return other.width > 0 && other.height > 0 && rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top;
      };
      const brand = document.createRange(); brand.selectNodeContents(document.querySelector('.brand'));
      return !element.closest('main') && rect.top >= 0 && rect.bottom <= 54 && rect.right <= innerWidth && rect.left > innerWidth / 2 &&
        ![brand, ...document.querySelectorAll('.rail nav a, .topbar .context, #resource-add, .resource-toolbar button')].some(overlaps);
    }), true, 'Top-right loading must not cover navigation or actions at ' + width);
    loadingLayout.set(width, await geometry());
    if ([1440, 390, 320].includes(width)) await page.screenshot({ path: join(directory, 'usage-loading-' + width + '.png'), fullPage: true });
  }
  initialRead.release(); await ready();
  for (const width of [1440, 960, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.deepEqual(await geometry(), loadingLayout.get(width), 'Loading completion must not shift the content at ' + width);
  }
  await page.screenshot({ path: join(directory, 'usage-default-320.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(directory, 'usage-default-desktop.png'), fullPage: true });
  assert.equal(await page.locator('.usage-metrics:visible').count(), 0, 'Statistics start collapsed independently of the resource branches');
  assert.equal(await page.locator('.resource-node[data-account]:not(.inventory-group)').count(), 2, 'Duplicate keys share two account nodes');
  assert.equal(await group('d1').evaluate(element => element.open), false);
  assert.doesNotMatch(await group('d1').locator(':scope > summary').innerText(), /6 GB/);
  assert.equal(await page.locator('[data-stats]').evaluateAll(buttons => buttons.every(button => button.getAttribute('aria-expanded') === 'false' && document.getElementById(button.getAttribute('aria-controls'))?.hidden)), true);
  assert.equal(await group('d1').getByRole('button', { name: 'D1 · 展开统计', exact: true }).count(), 1);
  await group('d1').locator(':scope > summary').focus(); await page.keyboard.press('Tab');
  assert.equal(await statsToggle(group('d1')).evaluate(element => element === document.activeElement), true, 'The statistics button is a separate keyboard stop');
  await statsToggle(group('d1')).click();
  assert.equal(await stats(group('d1')).isVisible(), true);
  assert.equal(await group('d1').evaluate(element => element.open), false, 'Opening statistics must not open the resource branch');
  assert.match(await stats(group('d1')).textContent(), /6 GB \/ 5 GB/);
  assert.match(await stats(group('d1')).textContent(), /超出 1 GB/);
  assert.equal(await group('d1').locator('[data-detail]').count(), 2);
  const brand = page.locator('[data-node-key="brand/cloudflare"]');
  await statsToggle(brand).click();
  assert.equal(await stats(brand).locator('[data-metric="d1/storage"] [role=progressbar]').isVisible(), true);
  assert.match(await stats(brand).locator('[data-metric="d1/storage"]').textContent(), /7 GB \/ 10 GB/);
  await statsToggle(brand).click();
  assert.equal(await stats(group('d1')).isVisible(), true, 'Closing parent statistics must not close child statistics');
  const account = page.locator(`.resource-node[data-account="${accountA}"]:not(.inventory-group)`);
  await statsToggle(account).click(); assert.equal(await stats(account).isVisible(), true);
  await statsToggle(account).click(); assert.equal(await stats(group('d1')).isVisible(), true);
  await statsToggle(group('kv')).click(); await statsToggle(group('d1')).focus(); await page.keyboard.press('Enter');
  assert.equal(await stats(group('d1')).isVisible(), false);
  assert.equal(await stats(group('kv')).isVisible(), true, 'Sibling statistics are independent');
  assert.equal(await group('d1').evaluate(element => element.open), false);
  await page.keyboard.press('Space');
  assert.equal(await stats(group('d1')).isVisible(), true);
  assert.equal(await group('d1').evaluate(element => element.open), false, 'Keyboard statistics activation must not toggle the branch');
  await stats(group('d1')).locator('.usage-amount').click();
  assert.equal(await group('d1').evaluate(element => element.open), false, 'Reading statistics must not toggle the branch');
  await statsToggle(group('kv')).click(); await open(group('d1'));
  assert.equal(await stats(group('d1')).isVisible(), true);
  await group('d1').locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await group('d1').evaluate(element => element.open), false);
  assert.equal(await stats(group('d1')).isVisible(), true, 'Closing the branch must not close its statistics');
  await open(group('d1'));
  const usageRead = holdRequest((request, body) => body?.action === 'usage' && body.kind === 'd1');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await usageRead.observed;
  await statsToggle(group('d1')).focus(); usageRead.release(); await ready();
  assert.equal(await statsToggle(group('d1')).evaluate(element => element === document.activeElement), true, 'Asynchronous updates restore the independent statistics trigger');
  assert.equal(await stats(group('d1')).isVisible(), true);
  assert.equal(await group('d1').evaluate(element => element.open), true);
  assert.equal(await stats(brand).isVisible(), false);
  await page.screenshot({ path: join(directory, 'usage-account-desktop.png'), fullPage: true });
  await open(group('d1')); const instance = group('d1').locator(`[data-detail="${databaseOne}"]`); await instance.click();
  await page.locator('#resource-detail-dialog[open]').waitFor(); const accountDetail = await page.locator('#resource-detail').textContent();
  assert.match(accountDetail, /4 GB/); assert.match(accountDetail, /账户共享套餐额度5 GB/);
  await page.keyboard.press('Escape'); assert.equal(await instance.evaluate(element => element === document.activeElement), true);
  const readCount = reads.length; await page.locator('#resource-view-kind').click();
  assert.equal(await page.locator('#resource-view-kind').getAttribute('aria-pressed'), 'true'); assert.equal(reads.length, readCount);
  const d1Root = page.locator('[data-resource-kind=d1]'); assert.equal(await d1Root.evaluate(element => element.open), false);
  assert.equal(await stats(d1Root).isVisible(), false);
  await statsToggle(d1Root).click();
  assert.match(await stats(d1Root).textContent(), /7 GB \/ 10 GB/);
  assert.match(await stats(d1Root).textContent(), /剩余 4 GB/);
  assert.match(await stats(d1Root).textContent(), /超出 1 GB/);
  assert.equal(await d1Root.evaluate(element => element.open), false);
  await open(d1Root);
  assert.equal(await stats(group('d1')).isVisible(), false, 'Each view keeps its own statistics state');
  await open(d1Root); await open(group('d1')); await group('d1').locator(`[data-detail="${databaseOne}"]`).click();
  assert.equal(await page.locator('#resource-detail').textContent(), accountDetail, 'Both paths open the identical instance detail');
  await page.keyboard.press('Escape');
  for (const width of [1440, 960, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, String(width));
    if ([1440, 390, 320].includes(width)) await page.screenshot({ path: join(directory, 'usage-resource-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#resource-view-account').click(); assert.equal(await group('d1').evaluate(element => element.open), true, 'Expansion state survives view switches');
  assert.equal(await stats(group('d1')).isVisible(), true, 'Statistics state survives view switches');
  assert.equal(await stats(brand).isVisible(), false);
  await statsToggle(group('r2')).click();
  await open(group('r2')); await group('r2').getByRole('button', { name: '规划容量', exact: true }).click();
  await page.locator('#resource-budget-value').fill('10'); await page.locator('#resource-budget-save').click();
  await page.waitForFunction(() => !document.getElementById('resource-budget-dialog').open);
  assert.equal(await group('r2').locator('[data-budget]').evaluate(element => element === document.activeElement), true, 'Planning save restores the re-rendered trigger');
  assert.deepEqual(writes, ['budget']);
  assert.equal(await stats(group('r2')).isVisible(), true, 'Planning updates preserve statistics visibility');
  assert.match(await stats(group('r2')).locator('[data-metric="r2/planning-storage"]').textContent(), /14 GB \/ 10 GB.*手工规划.*超出 4 GB/s);
  assert.equal(await group('r2').getByRole('button', { name: '用于部署', exact: true }).isEnabled(), true, 'Overage never disables deployment');
  await page.reload(); await ready(); assert.equal(await page.locator('.usage-metrics:visible').count(), 0, 'A fresh page does not persist display preferences');
  await statsToggle(group('r2')).click(); assert.match(await stats(group('r2')).textContent(), /手工规划/);
  await page.locator('#resource-view-kind').click(); await open(page.locator('[data-resource-kind=r2]')); await open(group('r2'));
  await group('r2').getByRole('button', { name: '规划容量', exact: true }).click(); assert.equal(await page.locator('#resource-budget-value').inputValue(), '10');
  await page.locator('#resource-budget-clear').click(); await page.waitForFunction(() => !document.getElementById('resource-budget-dialog').open);
  assert.equal(await group('r2').locator('[data-budget]').evaluate(element => element === document.activeElement), true);
  assert.deepEqual(writes, ['budget', 'budget']); assert.equal(await page.locator('[data-metric="r2/planning-storage"]').count(), 0);
  state.usageDenied = true; await page.reload(); await ready();
  await statsToggle(group('d1')).click(); assert.match(await stats(group('d1')).textContent(), /— \/ —/);
  assert.equal(await stats(group('d1')).locator('[role=progressbar]').count(), 0);
  assert.match(await group('d1').textContent(), /用量未提供/); assert.equal(await group('d1').locator('[data-detail]').count(), 2);
  state.usageDenied = false; state.r2Denied = true; await page.reload(); await ready();
  assert.match(await group('r2', accountB).locator(':scope > summary').innerText(), /读取失败/);
  assert.equal(await stats(group('r2', accountB)).isVisible(), false, 'Permission errors stay visible without opening statistics');
  await statsToggle(group('d1')).click(); assert.match(await stats(group('d1')).textContent(), /6 GB \/ 5 GB/);
  assert.equal(await page.locator('.status-line').isVisible(), false);
  assert.deepEqual(writes, ['budget', 'budget']); assert.ok(!JSON.stringify(await page.content()).includes(fakeToken));
  token = 'invalid'; await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.getByText('身份验证失败，请重新登录', { exact: true }).waitFor();
  assert.equal(await page.locator('.status-line').isVisible(), true);
  assert.equal(await page.locator('#resource-loading').textContent(), '', 'Failed identity clears routine loading but preserves the error');
  assert.equal(await page.locator('#resource-accounts').textContent(), '');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  console.log('PASS UI-07: independent statistics/branches, keyboard and refresh/view focus, top-right loading without layout shifts, two views, shared instances/quotas, account overage, manual planning persistence, unknowns, partial permissions, 5 widths and no deployment writes; synthetic providers');
} finally { await browser?.close(); await f.close(); }
