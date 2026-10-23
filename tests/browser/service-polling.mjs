import assert from 'node:assert/strict';
import { serviceBrowser, ready } from './service-fixture.mjs';

// Actual page, synthetic instance reads. No provider dispatch or deployment writes.
const suite = await serviceBrowser(), { page, auth, requests, state, errors } = suite;
const entries = ['complete', 'active'].map((id, index) => ({ id, taskId: id, createdAt: Date.now() + index }));
let activeStatus = 'running', verification = null;
auth.intercept = async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/admin/deployments/services') {
    await route.fulfill({ json: { services: entries } }); return true;
  }
  if (path.endsWith('/service-state')) {
    const { instanceId } = request.postDataJSON();
    const status = instanceId === 'active' ? activeStatus : 'succeeded';
    await route.fulfill({ json: { status, taskId: instanceId, job: { status, request: { applicationVersion: '1.0.0', sourceSha: 'a'.repeat(40) } }, ...(instanceId === 'active' && verification ? { verification } : {}) } }); return true;
  }
  return false;
};
const count = (path, id) => requests.filter(row => row.path === '/api/admin/deployments/' + path && (!id || row.body?.instanceId === id)).length;
try {
  await page.clock.install();
  await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('.service-status').length === 2 && !document.querySelector('#service-list').textContent.includes('正在读取'));
  assert.equal(count('services'), 1);
  assert.equal(count('service-state', 'complete'), 1);
  assert.equal(count('service-state', 'active'), 1);
  await page.clock.runFor(5100);
  await page.waitForFunction(() => document.querySelector('#service-list').textContent.includes('部署中'));
  assert.equal(count('services'), 1, 'timer must not reload the instance index');
  assert.equal(count('service-state', 'complete'), 1, 'terminal instances must not be polled');
  assert.equal(count('service-state', 'active'), 2);
  activeStatus = 'succeeded'; verification = { status: 'running', taskId: 'verification', createdAt: Date.now() };
  await page.clock.runFor(5100);
  await page.getByText('验证中', { exact: true }).waitFor();
  const beforeHidden = count('service-state');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(10000);
  assert.equal(count('service-state'), beforeHidden);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/service-state') && response.request().postDataJSON().instanceId === 'complete'),
    page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); dispatchEvent(new Event('visibilitychange')); }),
  ]);
  assert.equal(count('services'), 2, 'visibility recovery must refresh the full index');
  assert.equal(count('service-state', 'complete'), 2);
  verification = { ...verification, status: 'succeeded' };
  await page.clock.runFor(5100);
  await page.getByText('可用性已验证', { exact: true }).waitFor();
  const terminal = count('service-state');
  await page.clock.runFor(15000);
  assert.equal(count('service-state'), terminal, 'all terminal states must stop polling');
  assert.equal(state.dispatches, 0);
  assert.deepEqual(errors, []);
  console.log('PASS active-only polling: terminal exclusion, no repeated list fetch, verification, hidden/resume, terminal stop, zero dispatches');
} finally { await suite.close(); }
