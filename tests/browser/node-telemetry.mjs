import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';
import { heartbeatSample } from '../cloud/heartbeat-fixture.mjs';
import { telemetryFlags, telemetryOptions, telemetryNode, telemetrySample, telemetryRpc, cpu, memory, disk } from '../cloud/telemetry-helper.mjs';

const f = await adminFixture(telemetryFlags, telemetryOptions); let browser, release;
try {
  const a = await telemetryNode(f); await telemetrySample(f, a.roles.observe, cpu(), memory(), disk()); await heartbeatSample(f, a.roles.execute);
  f.bindings.ENROLLMENT_FAULT = 'catalog-finalize-before'; await f.restart();
  const b = await telemetryNode(f); await telemetrySample(f, b.roles.observe, cpu(12), memory(1), disk(1)); await telemetryRpc(f, b.telemetryContext, 'damage', ['age', 90000]);
  const failed = await telemetryNode(f); await telemetrySample(f, failed.roles.observe, { ...cpu(), status: 'unavailable', reason: 'read-failed', sampledAt: null, logicalCpuCount: null, intervalMs: null, usagePercent: null }, { ...memory(), status: 'unavailable', reason: 'memavailable-missing', sampledAt: null, totalBytes: null, availableBytes: null, usedBytes: null, usagePercent: null });
  const warming = await telemetryNode(f); await telemetrySample(f, warming.roles.observe, { ...cpu(), status: 'unknown', reason: 'warming-up', intervalMs: null, usagePercent: null });
  const legacy = await telemetryNode(f); await telemetrySample(f, legacy.roles.observe);
  const memoryLegacy = await telemetryNode(f); await telemetrySample(f, memoryLegacy.roles.observe, cpu(), memory());
  const pending = await telemetryNode(f, {}, false), nodes = [a, b, failed, warming, legacy, memoryLegacy];
  const before = await Promise.all(nodes.map(n => telemetryRpc(f, n.telemetryContext, 'inspect')));
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }), requests = [], errors = []; let token = a.token, fail = false, heldPath, mismatch = false, delay = false, overrideReading = null, near = false, holdFinished = false, mutate;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin); requests.push({ path: url.pathname, method: request.method() });
    if (fail && url.pathname === a.path) { await route.abort(); return; }
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token }, ...(request.postData() === null ? {} : { body: request.postData() }) });
    let body = Buffer.from(await response.arrayBuffer());
    if (url.pathname === a.path && (overrideReading !== null || near)) { const value = JSON.parse(body); if (overrideReading !== null) { value.sample.cpu.usagePercent = overrideReading; value.sample.memory = memory(overrideReading); value.sample.disk = disk(overrideReading); } if (near) value.sample.receivedAt = value.evaluatedAt - 89000; body = Buffer.from(JSON.stringify(value)); }
    if (url.pathname === a.path && mutate) { const value = JSON.parse(body); mutate(value); body = Buffer.from(JSON.stringify(value)); }
    if (mismatch && url.pathname === a.path) { const value = JSON.parse(body); value.ownerId = '0'.repeat(64); body = Buffer.from(JSON.stringify(value)); }
    const held = url.pathname === heldPath;
    if (held) { heldPath = null; holdFinished = false; await new Promise(resolve => { release = resolve; }); }
    if (delay && url.pathname === a.path) { delay = false; const value = JSON.parse(body); value.sample.receivedAt = value.evaluatedAt - 89000; body = Buffer.from(JSON.stringify(value)); await page.clock.fastForward(1001); }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
    if (held) holdFinished = true;
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.clock.install();
  const row = n => page.locator(`[data-server-id="${n.context.nodeId}"]`), panel = n => row(n).locator('[data-telemetry]'), ready = () => page.getByText(/目录版本 \d+/).waitFor();
  await page.goto(origin + '/history'); await ready();
  await panel(a).getByText(/CPU：0.00%.*最近已接收/).waitFor(); await panel(b).getByText(/CPU：12.00%.*陈旧/).waitFor();
  await panel(a).getByText(/内存：0.00%.*最近已接收.*已用 0.00 GiB（0 bytes）/).waitFor(); await panel(b).getByText(/内存：0.00%.*陈旧.*已用 0.00 GiB（1 bytes）/).waitFor();
  await panel(legacy).getByText(/内存未上报.*旧 CPU-only/).waitFor(); await panel(failed).getByText(/内存：采集不可用.*memavailable-missing/).waitFor();
  await panel(failed).getByText(/CPU：采集不可用.*read-failed/).waitFor(); await panel(pending).getByText(/尚无已确认采样/).waitFor(); assert.match(await row(b).textContent(), /加入中或待核对/);
  await panel(warming).getByText(/CPU：采集未知.*warming-up/).waitFor(); assert.equal((await panel(warming).textContent()).includes('0.00%'), false);
  await panel(a).getByText(/挂载点 \/.*0.00%.*已用 0.00 GiB（0 bytes）/).waitFor();
  await panel(b).getByText(/挂载点 \/.*0.10%.*陈旧/).waitFor();
  await panel(legacy).getByText(/磁盘未上报.*旧客户端/).waitFor(); await panel(memoryLegacy).getByText(/磁盘未上报.*旧客户端/).waitFor();
  assert.equal((await panel(a).textContent()).includes('磁盘未确认'), false);
  for (const n of [...nodes, pending]) assert.equal(requests.filter(r => r.path === n.path).length, 1, 'one telemetry GET per initial node render');
  assert.match(await panel(a).textContent(), /采样时间 1970.*云端接收时间/); assert.match(await panel(a).textContent(), /范围 linux-proc-stat/);
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/node-telemetry-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: 'test-results/node-telemetry-synthetic-mobile.png', fullPage: true });
  mutate = v => { v.sample.memory = memory(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); }; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/内存：100.00%.*9007199254740991 bytes/).waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: 'test-results/node-telemetry-synthetic-mobile-extreme.png', fullPage: true });
  for (const change of [v => { v.sample.memory.usedBytes = 1; }, v => { delete v.sample.memory; }, v => { v.sample.sampleVersion = 99; }, v => { delete v.sample.sampleVersion; }]) {
    mutate = change; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/内存未确认/).waitFor(); await panel(a).getByText(/CPU：0.00%/).waitFor(); assert.equal((await panel(a).textContent()).includes('内存未上报'), false);
  }
  for (const change of [v => { v.sample.disk.mounts[0].usedBytes = 1; }, v => { delete v.sample.disk; }, v => { v.sample.disk.mounts.push({ ...v.sample.disk.mounts[0] }); }, v => { v.sample.disk.raw = 'not allowed'; }]) {
    mutate = change; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/磁盘未确认/).waitFor(); await panel(a).getByText(/CPU：0.00%/).waitFor(); await panel(a).getByText(/内存：0.00%/).waitFor();
  }
  mutate = v => { v.sample.disk = { ...disk(), status: 'unavailable', reason: 'report-too-large', sampledAt: null, mounts: [], filtered: null }; }; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/磁盘未上报.*超过 6 KiB/).waitFor(); await panel(a).getByText(/内存：0.00%/).waitFor();
  mutate = v => { v.sample.disk = disk(); v.sample.disk.status = 'partial'; v.sample.disk.reason = 'mount-unavailable'; v.sample.disk.mounts.push({ ...disk().mounts[0], mountId: 2, mountPoint: '/<img src=x onerror=alert(1)>', status: 'unavailable', reason: 'statfs-failed', totalBytes: null, freeBytes: null, availableBytes: null, usedBytes: null, reservedBytes: null, usagePercent: null }); };
  await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/磁盘：部分采集不可用/).waitFor(); await panel(a).getByText(/挂载点 \/<img.*statfs-failed.*数值未知/).waitFor(); assert.equal(await panel(a).locator('img').count(), 0); await panel(a).getByText(/挂载点 \/；.*0.00%/).waitFor();
  mutate = v => { v.sample.disk.mounts[0].mountPoint = '/' + '长路径'.repeat(300); Object.assign(v.sample.disk.mounts[0], { totalBytes: Number.MAX_SAFE_INTEGER, freeBytes: 0, availableBytes: 0, usedBytes: Number.MAX_SAFE_INTEGER, reservedBytes: 0, usagePercent: 100 }); };
  await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/挂载点 \/长路径.*100.00%.*9007199254740991 bytes/).waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: 'test-results/node-disk-synthetic-mobile-extreme.png', fullPage: true });
  mutate = v => { v.sample.memory.usedBytes = 1; }; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/内存未确认/).waitFor(); await panel(a).getByText(/挂载点 \/；.*0.00%/).waitFor();
  mutate = v => { v.sample.cpu.usagePercent = null; }; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU 未确认/).waitFor(); await panel(a).getByText(/内存：0.00%/).waitFor(); await panel(a).getByText(/挂载点 \/；.*0.00%/).waitFor(); mutate = null;
  await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU：0.00%/).waitFor();
  await page.clock.fastForward(30001); await panel(a).getByText(/CPU\/内存\/磁盘\/网络快照已过期/).waitFor();
  fail = true; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU\/内存\/磁盘\/网络未确认.*当前值未知/).waitFor(); assert.equal(await page.locator('#server-add').isEnabled(), true); await row(a).getByText(/执行角色：在线/).waitFor();
  fail = false; mismatch = true; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU\/内存\/磁盘\/网络未确认/).waitFor(); mismatch = false;
  delay = true; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU\/内存\/磁盘\/网络快照已过期/).waitFor();
  // 同 owner 的旧 render 迟到也不能覆盖新 render。
  heldPath = a.path; await page.locator('#catalog-refresh').click();
  const waitHold = async () => { const end = Date.now() + 10000; while (!release && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(release); };
  await waitHold(); overrideReading = 1; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU：1.00%/).waitFor(); release(); release = null;
  const holdEnd = Date.now() + 10000; while (!holdFinished && Date.now() < holdEnd) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(holdFinished, true); assert.match(await panel(a).textContent(), /CPU：1.00%/); assert.match(await panel(a).textContent(), /内存：.*已用 0.00 GiB（1 bytes）/); assert.match(await panel(a).textContent(), /挂载点 \/；.*0.10%.*已用 0.00 GiB（1 bytes）/); overrideReading = null;
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide'))); assert.equal(await page.locator('[data-telemetry]').count(), 0); await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await ready(); await panel(a).getByText(/CPU：0.00%/).waitFor();
  // 只推进可见性处理读到的单调时钟，不执行过期定时器，证明 handler 自身生效。
  await page.evaluate(() => { const descriptor = Object.getOwnPropertyDescriptor(performance, 'now'), original = performance.now.bind(performance); Object.defineProperty(performance, 'now', { configurable: true, value: () => original() + 30001 }); document.dispatchEvent(new Event('visibilitychange')); if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete performance.now; }); await panel(a).getByText(/CPU\/内存\/磁盘\/网络快照已过期/).waitFor();
  near = true; await page.locator('#catalog-refresh').click(); await ready(); await panel(a).getByText(/CPU：0.00%.*最近已接收/).waitFor(); await page.clock.fastForward(1001); await panel(a).getByText(/CPU\/内存\/磁盘\/网络快照已过期/).waitFor(); near = false;
  heldPath = a.path; await page.locator('#catalog-refresh').click(); await waitHold(); token = f.jwt({ sub: 'new-telemetry-owner' }); await page.locator('#refresh').click(); await ready(); await page.getByText('尚无服务器目录条目', { exact: true }).waitFor(); release(); release = null; assert.equal(await page.locator('[data-telemetry]').count(), 0);
  assert.equal(requests.every(r => r.method === 'GET'), true); assert.equal(requests.some(r => r.path.startsWith('/node/')), false); assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(await Promise.all(nodes.map(n => telemetryRpc(f, n.telemetryContext, 'inspect'))), before);
  token = a.token; f.bindings.ENABLE_NODE_TELEMETRY = 'no'; await f.restart(); const previous = requests.filter(r => r.path.endsWith('/telemetry')).length; await page.locator('#refresh').click(); await ready(); await panel(a).getByText(/CPU\/内存\/磁盘\/网络上报功能未启用/).waitFor(); assert.equal(requests.filter(r => r.path.endsWith('/telemetry')).length, previous);
  console.log('PASS node telemetry: real Chrome + workerd/SQLite, CPU/memory/disk independent validation, disk per-mount zero/nonzero/partial/oversize/malformed/XSS/legacy and memory zero/nonzero bytes/legacy missing/unavailable/malformed/version mismatch/stale, enrolling joined, request failure/identity mismatch/elapsed request/expired snapshot, late render/owner, pagehide/BFCache/visibility, 390px; GET only, default-off, no writes or browser storage');
} finally { release?.(); await browser?.close(); await f.close(); }

await import('./network-telemetry.mjs');
