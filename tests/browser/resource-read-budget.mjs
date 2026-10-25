import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { usageFixture } from '../cloud/usage-fixture.mjs';
import { fakeToken } from '../cloud/connections-fixture.mjs';
import { origin } from '../cloud/admin-fixture.mjs';

const { f } = await usageFixture(); let browser;
try {
  const token = f.jwt(), headers = { 'x-csrf-token': (await f.call('/api/admin/state', { token })).json().csrf };
  assert.equal((await f.call('/api/admin/connections', { token, headers, body: {
    action: 'connect', id: crypto.randomUUID(), name: '读取预算', provider: 'cloudflare', accountId: '', token: fakeToken,
  } })).status, 200);
  const writes = [], errors = [];
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async route => {
    const req = route.request(); assert.equal(new URL(req.url()).origin, origin);
    const body = req.postData() ? req.postDataJSON() : null;
    if (body && !['inventory', 'usage'].includes(body.action)) writes.push(body.action);
    // Keep ordinary workerd I/O observably asynchronous while the browser clock is paused.
    if (body && ['inventory', 'usage'].includes(body.action)) await new Promise(resolve => setTimeout(resolve, 40));
    const response = await f.mf.dispatchFetch(req.url(), { method: req.method(), headers: {
      ...req.headers(), 'cf-access-jwt-assertion': token,
    }, ...(body ? { body: req.postData() } : {}) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  // Synthetic held reads exercise the real controller, including the response-body phase.
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.readProbe = { next: null, records: [], release: null, normalPending: 0 };
    window.fetch = (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null, action = body?.action ?? 'get';
      const probe = window.readProbe, mode = probe.next;
      if (!mode || action !== mode.action) {
        probe.normalPending++;
        return original(path, options).then(response => {
          if (!response.ok) { probe.normalPending--; return response; }
          const json = response.json.bind(response);
          response.json = async () => { try { return await json(); } finally { probe.normalPending--; } };
          return response;
        }, error => { probe.normalPending--; throw error; });
      }
      probe.next = null;
      const record = { action, signal: !!options.signal, aborted: !!options.signal?.aborted };
      probe.records.push(record);
      const pending = new Promise((resolve, reject) => {
        probe.release = () => resolve(new Response('{}', { status: mode.status ?? 200 }));
        options.signal?.addEventListener('abort', () => {
          record.aborted = true;
          if (!mode.ignoreAbort) reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      return mode.json ? Promise.resolve({ ok: true, status: 200, json: () => pending }) : pending;
    };
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-25T01:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-25T01:00:01Z'));
  const ready = () => page.waitForFunction(() => !document.getElementById('resource-fields').disabled && document.getElementById('resource-loading').textContent === '');
  const hold = async mode => {
    const previous = await page.evaluate(mode => { window.readProbe.next = mode; return window.readProbe.records.length; }, mode);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(count => window.readProbe.records.length > count, previous);
    // Advancing virtual time must not expire unrelated real workerd I/O on a slow runner.
    await page.waitForFunction(() => window.readProbe.normalPending === 0);
  };
  const last = () => page.evaluate(() => window.readProbe.records.at(-1));
  await page.goto(origin + '/resources'); await ready();
  const baselineErrors = await page.locator('.inventory-status[data-tone=error]').count();
  for (const mode of [{ action: 'inventory', deadline: 15000 }, { action: 'usage', deadline: 45000 }, { action: 'inventory', deadline: 15000, json: true }, { action: 'usage', deadline: 45000, json: true }]) {
    await hold(mode); assert.equal((await last()).signal, true, 'Only reads receive a controller');
    await page.clock.runFor(mode.deadline - 1); assert.equal((await last()).aborted, false, 'Do not cut a read short');
    await page.clock.runFor(2);
    assert.equal((await last()).aborted, true, 'Read deadline aborts fetch or body consumption'); await ready();
    assert.equal(await page.locator('#resource-notice').textContent(), '');
    if (mode.action === 'inventory') assert.equal(await page.locator('.inventory-status[data-tone=error]').count(), baselineErrors + 1, 'A timed-out inventory is not an empty complete list');
    else assert.match(await page.locator('[data-kind=worker]').first().textContent(), /用量未提供/, 'Unknown usage is not zero');
  }
  await hold({ action: 'inventory' });
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal((await last()).aborted, true, 'Pagehide cancels outstanding reads');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await ready();
  assert.equal(await page.locator('.inventory-status[data-tone=error]').count(), baselineErrors, 'Restored page reads afresh');
  await hold({ action: 'inventory', ignoreAbort: true, status: 403 });
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide')); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); }); await ready();
  await page.evaluate(() => window.readProbe.release());
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#resource-notice').textContent(), '', 'Late old 403 cannot invalidate a newer generation');
  assert.equal(await page.locator('#resource-fields').isDisabled(), false);
  await page.locator('#resource-add').click(); await page.locator('#resource-name').fill('写操作保护'); await page.locator('#resource-token').fill(fakeToken);
  await page.evaluate(() => { window.readProbe.next = { action: 'connect', status: 500 }; });
  await page.locator('#resource-save').click(); await page.waitForFunction(() => window.readProbe.records.at(-1)?.action === 'connect');
  assert.equal((await last()).signal, false, 'Mutation must not inherit a read deadline');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide'))); await page.clock.runFor(45001);
  assert.equal((await last()).aborted, false, 'Pagehide does not claim to cancel or roll back a mutation');
  await page.evaluate(() => { window.readProbe.release(); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); }); await ready();
  assert.equal((await page.evaluate(() => window.readProbe.records)).filter(row => row.action === 'connect').length, 1, 'No automatic mutation replay');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#resource-view-kind').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#resource-view-kind').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  console.log('PASS PERF-01: synthetic 15s inventory/body and 45s usage deadlines, pagehide abort, BFCache recovery, stale 403 isolation, mutation no-signal/no-replay, keyboard and narrow viewport; actual workerd/page, no production writes');
} finally { await browser?.close(); await f.close(); }
