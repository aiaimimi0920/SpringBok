import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { adminFixture, origin } from '../cloud/admin-fixture.mjs';
import { telemetryFlags, telemetryOptions, telemetryNode, telemetrySample, telemetryRpc, cpu, memory, disk, network } from '../cloud/telemetry-helper.mjs';

const f = await adminFixture(telemetryFlags, telemetryOptions); let browser, release;
const unknown = reason => ({ ...network(), status: 'unknown', reason, intervalMs: null, interfaces: [{ ...network().interfaces[0], status: 'unknown', reason, rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null }] });
const unavailable = reason => ({ ...network(), status: 'unavailable', reason, sampledAt: null, intervalMs: null, interfaces: [] });
try {
  const a = await telemetryNode(f), b = await telemetryNode(f), legacy = await telemetryNode(f);
  await telemetrySample(f, a.roles.observe, cpu(), memory(), disk(), network());
  await telemetrySample(f, b.roles.observe, cpu(1), memory(1), disk(1), network(1, 300));
  await telemetryRpc(f, b.telemetryContext, 'damage', ['age', 90000]);
  await telemetrySample(f, legacy.roles.observe, cpu(), memory(), disk());
  const nodes = [a, b, legacy], before = await Promise.all(nodes.map(n => telemetryRpc(f, n.telemetryContext, 'inspect')));
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }), requests = [], errors = [];
  let token = a.token, mutate, held = false, finished = false;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin); requests.push({ path: url.pathname, method: request.method() });
    const response = await f.mf.dispatchFetch(request.url(), { method: request.method(), headers: { ...request.headers(), 'cf-access-jwt-assertion': token } });
    let body = Buffer.from(await response.arrayBuffer());
    if (url.pathname === a.path && mutate) { const v = JSON.parse(body); mutate(v); body = Buffer.from(JSON.stringify(v)); }
    const hold = url.pathname === a.path && held;
    if (hold) { held = false; finished = false; await new Promise(resolve => { release = resolve; }); }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body }).catch(() => {});
    if (hold) finished = true;
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.clock.install();
  const panel = n => page.locator(`[data-server-id="${n.context.nodeId}"] [data-telemetry]`);
  const ready = () => page.getByText(/目录版本 \d+/).waitFor();
  const refresh = async change => { mutate = change; await page.locator('#catalog-refresh').click(); await ready(); };
  await page.goto(origin + '/history'); await ready();
  await panel(a).getByText(/接口 eth0；接收 0.00 bytes\/s；发送 0.00 bytes\/s；窗口接收 0 bytes；窗口发送 0 bytes.*最近已接收/).waitFor();
  await panel(b).getByText(/接口 eth0；接收 0.03 bytes\/s；发送 10.00 bytes\/s；窗口接收 1 bytes.*陈旧/).waitFor();
  await panel(legacy).getByText(/网络未上报.*旧客户端/).waitFor();
  for (const n of nodes) assert.equal(requests.filter(r => r.path === n.path).length, 1);
  mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/node-network-synthetic-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const reason of ['warming-up', 'context-changed', 'interface-set-changed']) {
    await refresh(v => { v.sample.network = unknown(reason); }); await panel(a).getByText(new RegExp(`网络：采集未知.*${reason}`)).waitFor(); await panel(a).getByText(/数值未知/).waitFor(); assert.equal((await panel(a).textContent()).includes('接收 0.00 bytes/s'), false);
  }
  for (const reason of ['read-failed', 'invalid-counters', 'no-interfaces', 'clock-unavailable']) { await refresh(v => { v.sample.network = unavailable(reason); }); await panel(a).getByText(new RegExp(`网络：采集不可用.*${reason}`)).waitFor(); await panel(a).getByText(/CPU：0.00%/).waitFor(); }
  await refresh(v => { v.sample.network = unavailable('report-too-large'); v.sample.disk = { ...disk(), status: 'unavailable', reason: 'report-too-large', sampledAt: null, mounts: [], filtered: null }; });
  await panel(a).getByText(/网络未上报.*超过 3 KiB/).waitFor(); await panel(a).getByText(/磁盘未上报.*超过 3 KiB/).waitFor();
  for (const change of [v => { delete v.sample.network; }, v => { v.sample.sampleVersion = 99; }, v => { v.sample.network.interfaces[0].rxBytesPerSecond = 1; }, v => { v.sample.network.interfaces.push({ ...v.sample.network.interfaces[0] }); }, v => { v.sample.network.interfaces[0].name = '<img src=x>'; }, v => { v.sample.network.ip = 'private'; }]) {
    await refresh(change); await panel(a).getByText(/网络未确认/).waitFor(); await panel(a).getByText(/CPU：0.00%/).waitFor(); assert.equal(await panel(a).locator('img').count(), 0);
  }
  await refresh(v => { v.sample.network = network(300); v.sample.network.status = 'partial'; v.sample.network.reason = 'interface-unavailable'; v.sample.network.interfaces.push({ ...unknown('warming-up').interfaces[0], name: 'lo', reason: 'counter-regressed' }); });
  await panel(a).getByText(/网络：部分采集未知/).waitFor(); await panel(a).getByText(/接口 eth0；接收 10.00 bytes\/s/).waitFor(); await panel(a).getByText(/接口 lo；采集未知；counter-regressed/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: 'test-results/node-network-synthetic-mobile-partial.png', fullPage: true });
  await refresh(v => { const n = network(); n.intervalMs = Number.MAX_SAFE_INTEGER / 1000000; n.interfaces[0] = { ...n.interfaces[0], name: 'eth012345678901', rxBytes: Number.MAX_SAFE_INTEGER, txBytes: Number.MAX_SAFE_INTEGER, rxBytesPerSecond: 1000000000, txBytesPerSecond: 1000000000 }; v.sample.network = n; });
  await panel(a).getByText(/9007199254740991 bytes/).waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: 'test-results/node-network-synthetic-mobile-extreme.png', fullPage: true });
  for (const field of ['cpu', 'memory', 'disk']) { await refresh(v => { v.sample[field] = null; }); await panel(a).getByText(/接口 eth0；接收 0.00 bytes\/s/).waitFor(); }
  await refresh(); await panel(a).getByText(/网络：采集可用.*最近已接收/).waitFor();
  await page.clock.fastForward(30001); await panel(a).getByText(/网络快照已过期/).waitFor(); assert.equal((await panel(a).textContent()).includes('bytes/s'), false);
  await refresh(v => { v.sample.receivedAt = v.evaluatedAt - 89000; }); await panel(a).getByText(/网络：采集可用.*最近已接收/).waitFor(); await page.clock.fastForward(1001); await panel(a).getByText(/网络快照已过期/).waitFor();
  const waitFor = async predicate => { const end = Date.now() + 10000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate()); };
  held = true; await refresh(); await waitFor(() => release);
  await refresh(v => { v.sample.network = network(300); }); await panel(a).getByText(/接口 eth0；接收 10.00 bytes\/s/).waitFor(); release(); release = null; await waitFor(() => finished); assert.match(await panel(a).textContent(), /接口 eth0；接收 10.00 bytes\/s/);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide'))); assert.equal(await page.locator('[data-telemetry]').count(), 0); await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await ready(); await panel(a).getByText(/接口 eth0；接收 10.00 bytes\/s/).waitFor();
  await page.evaluate(() => { const descriptor = Object.getOwnPropertyDescriptor(performance, 'now'), original = performance.now.bind(performance); Object.defineProperty(performance, 'now', { configurable: true, value: () => original() + 30001 }); document.dispatchEvent(new Event('visibilitychange')); if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete performance.now; }); await panel(a).getByText(/网络快照已过期/).waitFor();
  held = true; await refresh(); await waitFor(() => release); token = f.jwt({ sub: 'network-other-owner' }); await page.locator('#refresh').click(); await ready(); await page.getByText('尚无服务器目录条目', { exact: true }).waitFor(); release(); release = null; await waitFor(() => finished); assert.equal(await page.locator('[data-telemetry]').count(), 0);
  assert.ok(requests.every(r => r.method === 'GET')); assert.equal(requests.some(r => r.path.startsWith('/node/')), false); assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(await Promise.all(nodes.map(n => telemetryRpc(f, n.telemetryContext, 'inspect'))), before);
  console.log('PASS network telemetry: real browser/workerd, zero/nonzero/unknown/partial/unavailable/oversize/malformed/legacy, isolated metrics, exact bytes and 390px, expiry/late render/owner/pagehide/BFCache/visibility; one GET, no writes/storage');
} finally { release?.(); await browser?.close(); await f.close(); }
