import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';
import { heartbeatFlags, heartbeatOptions, heartbeatNode, heartbeatSample, heartbeatRpc } from '../cloud/heartbeat-fixture.mjs';

const f = await adminFixture(heartbeatFlags, heartbeatOptions); let browser, release;
try {
  const a = await heartbeatNode(f); await heartbeatSample(f, a.roles.execute, 8640000000000000);
  f.bindings.ENROLLMENT_FAULT = 'catalog-finalize-before'; await f.restart();
  const b = await heartbeatNode(f); await heartbeatSample(f, b.roles.execute); await heartbeatSample(f, b.roles.observe);
  await heartbeatRpc(f, b.context, 'damage', ['heartbeat-age', 'execute', 90000]);
  await heartbeatRpc(f, b.context, 'damage', ['heartbeat-age', 'observe', 300000]);
  const pending = await heartbeatNode(f, {}, false);
  const storage = await Promise.all([a, b, pending].map(n => heartbeatRpc(f, n.context, 'inspect')));
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }), requests = [], errors = [];
  let token = a.token, failHeartbeat = false, holdPath;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin);
    requests.push({ path: url.pathname, method: request.method() });
    if (failHeartbeat && url.pathname === a.path) { await route.abort(); return; }
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token }, ...(request.postData() === null ? {} : { body: request.postData() }) });
    const body = Buffer.from(await response.arrayBuffer());
    if (url.pathname === holdPath) { holdPath = null; await new Promise(resolve => { release = resolve; }); }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.clock.install();
  const row = n => page.locator(`[data-server-id="${n.context.nodeId}"]`), ready = () => page.getByText(/目录版本 \d+；这里仅登记元数据/).waitFor();
  await page.goto(origin); await ready();
  await row(a).locator('[data-heartbeat-role="execute"]').getByText(/执行角色：在线/).waitFor();
  await row(a).locator('[data-heartbeat-role="observe"]').getByText(/未知\/尚无心跳/).waitFor();
  await row(b).getByText(/加入中或待核对/).waitFor();
  await row(b).locator('[data-heartbeat-role="execute"]').getByText(/执行角色：陈旧/).waitFor();
  await row(b).locator('[data-heartbeat-role="observe"]').getByText(/采集角色：离线/).waitFor();
  await row(pending).locator('[data-heartbeat-role="execute"]').getByText(/未知\/尚无心跳/).waitFor();
  assert.match(await row(a).textContent(), /\+275760/); assert.match(await row(a).textContent(), /云端接收时间/);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/node-heartbeat-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/node-heartbeat-synthetic-mobile.png', fullPage: true });
  await page.clock.fastForward(30001); await row(a).getByText(/心跳快照已过期/).waitFor();
  // 独立心跳读失败不清目录，不成为“已确认离线”，也不发送任何写请求。
  failHeartbeat = true; await page.locator('#catalog-refresh').click(); await ready();
  await row(a).getByText(/心跳未确认：当前状态未知/).waitFor(); assert.equal(await page.locator('#servers > li[data-server-id]').count(), 3); assert.equal(await page.locator('#server-add').isEnabled(), true);
  failHeartbeat = false; holdPath = a.path; await page.locator('#catalog-refresh').click();
  const end = Date.now() + 10000; while (!release && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(release);
  token = f.jwt({ sub: 'new-heartbeat-owner' }); await page.locator('#refresh').click(); await ready();
  await page.getByText('尚无服务器目录条目', { exact: true }).waitFor(); release(); release = null;
  assert.equal(await page.locator('[data-heartbeat]').count(), 0); assert.equal(await page.locator('#servers > li[data-server-id]').count(), 0);
  assert.equal(requests.every(r => r.method === 'GET'), true); assert.equal(requests.some(r => r.path.startsWith('/node/')), false);
  assert.deepEqual(await Promise.all([a, b, pending].map(n => heartbeatRpc(f, n.context, 'inspect'))), storage);
  assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  console.log('PASS node heartbeat: real Chrome + workerd/SQLite, independent roles/nodes, future sampling, enrolling joined, unknown/online/stale/offline, read failure, expired snapshot, late owner, 390px; GET only and no task/enrollment changes');
} finally { release?.(); await browser?.close(); await f.close(); }
