import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, openSync, fchmodSync, fstatSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';
import { openEnrollmentClient } from '../../src/node-enrollment/client.mjs';

const f = await adminFixture({ ENABLE_CATALOG: 'yes', ENABLE_NODE_MAILBOX: 'yes', ENABLE_NODE_ENROLLMENT: 'yes', ENABLE_PROTOCOL_TEST: 'no', ENABLE_FIXTURE_CYCLE: 'no', ENROLLMENT_FAULT: 'catalog-finalize-before' }, { entryPoint: 'tests/cloud/enrollment-fixture.mjs' });
const directory = mkdtempSync(join(tmpdir(), 'springbok-enrollment-browser-'));
let browser, client, release;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  let token = f.jwt(), loseAuthorize = false, holdPath;
  const requests = [], errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin);
    requests.push({ path: url.pathname, method: request.method(), ...(request.postData() ? { input: JSON.parse(request.postData()) } : {}) });
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token }, ...(request.postData() === null ? {} : { body: request.postData() }) });
    const body = Buffer.from(await response.arrayBuffer());
    if (holdPath === url.pathname) { holdPath = null; await new Promise(resolve => { release = resolve; }); }
    if (loseAuthorize && url.pathname === '/api/admin/enrollments' && request.method() === 'POST') { loseAuthorize = false; await route.abort(); return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const rows = page.locator('#servers > li[data-server-id]'), notice = page.locator('#enrollment-notice');
  const posts = path => requests.filter(request => request.path === path && request.method === 'POST').length;
  const waitReady = () => page.getByText(/目录版本 \d+/).waitFor();
  async function create(name) {
    await page.getByLabel('新服务器名称', { exact: true }).fill(name); await page.locator('#server-add').click();
    await page.getByText(/目录已保存（版本 \d+）/).waitFor(); return rows.filter({ has: page.getByText(name, { exact: true }) });
  }
  async function saveGrant(row, name) {
    await row.getByRole('button', { name: '准备一次性加入', exact: true }).click(); await page.locator('#enrollment-dialog').waitFor();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#enrollment-download').click();
    const download = await downloadEvent, path = join(directory, name); await download.saveAs(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let grant;
    try {
      fchmodSync(fd, 0o600); const stat = fstatSync(fd); assert.ok(stat.isFile()); assert.equal(stat.mode & 0o077, 0);
      grant = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    assert.equal(grant.origin, origin); assert.equal(grant.nodeId, await row.getAttribute('data-server-id'));
    await page.locator('#enrollment-confirm-saved').check(); return grant;
  }
  async function waitHeld() {
    const until = Date.now() + 10000; while (!release && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(release, 'held response must arrive');
  }
  await page.goto(origin + '/history'); await waitReady(); const a = await create('一次性加入节点 A');
  // 准备、勾选和取消均不写；尚未下载材料时不能授权。
  await a.getByRole('button', { name: '准备一次性加入', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.locator('#enrollment-dialog').waitFor(); await page.locator('#enrollment-confirm-saved').check();
  assert.equal(await page.locator('#enrollment-authorize').isEnabled(), false); await page.locator('#enrollment-cancel').click(); assert.equal(posts('/api/admin/enrollments'), 0);
  await page.locator('#catalog-refresh').click(); await waitReady(); assert.equal(await page.locator('#enrollment-panel').isVisible(), true);
  const grant = await saveGrant(a, 'grant-a.json');
  await page.locator('#enrollment-authorize').evaluate(button => { button.click(); button.click(); }); await waitReady();
  await a.getByText(/加入中或待核对/).waitFor(); assert.equal(posts('/api/admin/enrollments'), 1);
  const input = requests.find(request => request.path === '/api/admin/enrollments' && request.method === 'POST').input;
  assert.deepEqual(Object.keys(input).sort(), ['challengeDigest', 'id', 'revision', 'serverId']); assert.equal(JSON.stringify(input).includes(grant.challenge), false);
  // 真实 Linux journal + Node 客户端 + workerd/SQLite，目录收尾故障可由显式管理员核对恢复。
  let nodeRequests = 0;
  const fetcher = (url, init) => { nodeRequests++; return f.mf.dispatchFetch(url, init); };
  client = openEnrollmentClient({ directory: join(directory, 'node-a'), grant, expectedOrigin: origin, fetcher });
  const joined = await client.step(); assert.equal(joined.directoryState, 'uncertain');
  await a.getByRole('button', { name: '核对加入状态', exact: true }).click(); await page.getByText(/节点 joined/).waitFor();
  assert.equal(posts('/api/admin/enrollments/reconcile'), 0);
  await page.locator('#enrollment-finish').evaluate(button => { button.click(); button.click(); }); await waitReady();
  await a.getByText(/已完成加入登记/).waitFor(); assert.equal(posts('/api/admin/enrollments/reconcile'), 1);
  assert.equal(await a.getByRole('button', { name: '保存名称', exact: true }).count(), 0);
  const active = await client.step(); assert.equal(active.directoryState, 'active'); assert.equal(active.requestId, joined.requestId);
  client.close(); client = openEnrollmentClient({ directory: join(directory, 'node-a'), grant, expectedOrigin: origin, fetcher });
  const before = nodeRequests; assert.equal((await client.step()).directoryState, 'active'); assert.equal(nodeRequests, before);
  await f.restart(); await page.reload(); await waitReady(); await a.getByText(/已完成加入登记/).waitFor();
  const b = await create('丢响应节点 B'); await saveGrant(b, 'grant-b.json'); loseAuthorize = true;
  await page.locator('#enrollment-authorize').click(); await page.getByText(/授权结果未确认。保留原材料/).waitFor();
  assert.equal(await page.locator('#enrollment-authorize').isEnabled(), false);
  const writes = posts('/api/admin/enrollments'); await page.reload(); await waitReady(); assert.equal(posts('/api/admin/enrollments'), writes);
  await b.getByRole('button', { name: '核对加入状态', exact: true }).click(); await page.getByText(/节点 pending/).waitFor();
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/node-enrollment-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/node-enrollment-synthetic-mobile.png', fullPage: true });
  // 迟到的旧 owner 核对响应不能写入新身份页面。
  holdPath = `/api/admin/enrollments/${grant.nodeId}`; await a.getByRole('button', { name: '核对加入状态', exact: true }).click(); await waitHeld();
  token = f.jwt({ sub: 'other-enrollment-owner' }); await page.locator('#refresh').click(); await waitReady(); release(); release = null;
  await page.getByText('尚无服务器目录条目', { exact: true }).waitFor(); assert.equal(await rows.count(), 0); assert.equal(await notice.textContent(), '');
  // 迟到授权同样不能重新启用或污染新身份；原 owner 已记录的结果保留在其目录。
  const c = await create('另一主体节点'); await saveGrant(c, 'grant-c.json'); holdPath = '/api/admin/enrollments';
  await page.locator('#enrollment-authorize').click(); await waitHeld(); token = f.jwt({ sub: 'third-enrollment-owner' });
  await page.locator('#refresh').evaluate(button => button.click()); await waitReady(); release(); release = null;
  await page.getByText('尚无服务器目录条目', { exact: true }).waitFor(); assert.equal(await page.locator('#enrollment-dialog').isVisible(), false); assert.equal(await notice.textContent(), '');
  token = f.jwt({ email: 'denied@example.invalid' }); await page.locator('#refresh').click(); await page.getByText(/身份、计划或记录已变化/).waitFor();
  assert.equal(await page.locator('#enrollment-panel').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert.deepEqual(errors, []);
  assert.equal(requests.some(request => request.path.startsWith('/node/') || ['/api/admin/preview', '/api/admin/submit'].includes(request.path)), false);
  assert.equal((await f.call('/api/admin/state')).json().jobs.length, 0);
  console.log('PASS node enrollment: real Chrome + workerd/SQLite + private Linux journal, save-before-authorize, cancel/double-click, one-time join, explicit cross-DO recovery, lost response, restart, stale owner responses, default metadata boundary and 390px; no deployment');
} finally { release?.(); client?.close(); await browser?.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
