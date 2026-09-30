import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo } from '../../src/demo/server.mjs';

const directory = mkdtempSync(join(tmpdir(), 'springbok-browser-'));
let app;
let browser;
const check = async (locator, text) => {
  const phase = ['模拟测试失败', '待模拟验收', '已模拟验收', '模拟版本已晋级', '待模拟测试', '模拟回滚失败', '已模拟回滚'].includes(text);
  await (phase ? locator.locator('.phase').filter({ hasText: new RegExp(`^${text}$`) }) : locator.getByText(text, { exact: true })).waitFor({ state: 'visible' });
};
try {
  app = await startDemo({ directory, port: 0 });
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin);
  await check(page, 'DEMO · 未连接真实服务器');
  await page.getByRole('article').first().waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('article').count(), 4);
  const gateway = page.getByRole('article', { name: 'Gateway 网关', exact: true });
  await gateway.getByRole('button', { name: '模拟测试失败', exact: true }).click();
  await check(gateway, '模拟测试失败');
  assert.equal(await gateway.getByRole('button', { name: '模拟晋级', exact: true }).isEnabled(), false);
  const approve = async card => {
    await check(card, '待模拟验收');
    const confirm = card.getByRole('button', { name: '确认模拟验收', exact: true });
    assert.equal(await confirm.isEnabled(), false);
    const checkbox = card.getByRole('checkbox');
    await checkbox.focus(); await checkbox.press('Space');
    assert.equal(await confirm.isEnabled(), true);
    await checkbox.press('Space'); assert.equal(await confirm.isEnabled(), false);
    await checkbox.press('Space'); await confirm.press('Enter');
    await check(card, '已模拟验收');
  };
  const release = async card => {
    await card.getByRole('button', { name: '模拟测试通过', exact: true }).click(); await approve(card);
    await card.getByRole('button', { name: '模拟晋级', exact: true }).click(); await check(card, '模拟版本已晋级');
  };
  await release(gateway);
  await gateway.getByRole('combobox').selectOption('v2');
  await gateway.getByRole('button', { name: '选择候选', exact: true }).click(); await check(gateway, '待模拟测试');
  await release(gateway);
  await gateway.getByRole('button', { name: '模拟回滚失败', exact: true }).click(); await check(gateway, '模拟回滚失败');
  await gateway.getByRole('button', { name: '模拟回滚', exact: true }).click(); await check(gateway, '已模拟回滚');
  await page.reload(); await check(gateway, '已模拟回滚');
  const forum = page.getByRole('article', { name: '论坛', exact: true });
  await forum.getByRole('button', { name: '模拟测试通过', exact: true }).click(); await approve(forum);
  const oldOrigin = app.origin;
  const port = Number(new URL(oldOrigin).port);
  await app.close(); app = await startDemo({ directory, port });
  // The still-open browser has a stale in-memory token and must not promote.
  await forum.getByRole('button', { name: '模拟晋级', exact: true }).click();
  await check(page, 'Refresh this demo session'); await check(forum, '待模拟验收');
  await check(gateway, '已模拟回滚');
  await approve(forum); await forum.getByRole('button', { name: '模拟晋级', exact: true }).click(); await check(forum, '模拟版本已晋级');
  // Independent tab captures an old revision; only the first transition may commit.
  const second = await browser.newPage(); await second.goto(app.origin);
  const game = page.getByRole('article', { name: '在线游戏', exact: true });
  await game.getByRole('button', { name: '模拟测试通过', exact: true }).click(); await check(game, '待模拟验收');
  await second.getByRole('article', { name: '在线游戏', exact: true }).getByRole('button', { name: '模拟测试失败', exact: true }).click();
  await check(second, '状态已变化，请刷新后重新操作');
  await check(second.getByRole('article', { name: '在线游戏', exact: true }), '待模拟验收');
  const account = page.getByRole('article', { name: '账号服务', exact: true });
  await account.getByRole('button', { name: '模拟测试通过', exact: true }).dblclick(); await check(account, '待模拟验收');
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await check(page, '已读取本地演示记录；没有执行真实部署');
  await page.reload(); await check(gateway, '已模拟回滚');
  assert.deepEqual(errors, []);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/demo-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/demo-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS: real Chrome UI, four cards, keyboard acceptance, failure/retry, v1/v2/rollback, reload/restart, stale session/tab, repeated click, mobile layout');
} finally {
  await browser?.close(); await app?.close(); rmSync(directory, { recursive: true, force: true });
}
