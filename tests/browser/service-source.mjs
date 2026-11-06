import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serviceBrowser, ready, reviewService } from './service-fixture.mjs';
import { updatedSha } from '../cloud/service-fixture.mjs';

const suite = await serviceBrowser(), { page, state, github, input, resource, requests, errors, auth } = suite;
let release;
try {
  const prior = state.provider;
  state.repositoryPages = [[{ id: 2, full_name: 'owner/repo', default_branch: 'main' }]];
  state.provider = (request, context) => new URL(request.url).pathname === '/repos/owner/repo/git/trees/main'
    ? Response.json({ sha: '1'.repeat(40), truncated: false, tree: [] }) : prior(request, context);
  await ready(page); await page.locator('#service-add').click();
  await page.getByText('未找到含 .sba 的服务', { exact: true }).waitFor();
  assert.equal(await page.locator('#service-tabs button').count(), 0);
  await page.getByRole('button', { name: '指定来源', exact: true }).click();
  const connection = page.getByLabel('GitHub 连接', { exact: true });
  const repository = page.getByLabel('仓库', { exact: true });
  const sha = page.getByLabel('提交 SHA', { exact: true });
  const read = page.getByRole('button', { name: '读取版本', exact: true });
  await connection.selectOption(github.id); await repository.fill('owner/repo');
  await sha.fill('migration/cloudflare-web');
  const reads = () => requests.filter(row => row.path.endsWith('/application') && row.body.sourceSha !== null);
  const before = reads().length; await read.click();
  assert.equal(reads().length, before, 'a floating branch cannot be submitted');
  await sha.fill(updatedSha); await read.click();
  await page.locator('#service-selection').filter({ hasText: 'owner/repo · v2.0.0' }).waitFor();
  assert.equal(await page.locator('#service-version').inputValue(), updatedSha);
  assert.deepEqual(reads().at(-1).body, { github, repository: 'owner/repo', sourceSha: updatedSha });
  assert.equal(state.dispatches, 0);
  assert.equal(requests.some(row => ['register', 'discover', 'use-repository'].includes(row.body?.action)), false);

  await page.locator('#service-environment').fill('testing');
  await page.locator('#service-resource-database').selectOption(resource.remoteId);
  await page.getByLabel('Worker 名称', { exact: true }).fill('test-worker');
  await reviewService(page);
  assert.match(await page.locator('#service-review').textContent(), new RegExp(updatedSha));
  assert.equal(await page.locator('#service-source').isVisible(), false);
  assert.equal(state.dispatches, 0, 'reading and reviewing never dispatch');
  await page.locator('#service-back').click();

  await connection.selectOption(input.github.id); await repository.fill('owner/second');
  await read.click();
  await page.locator('#service-dialog-notice').filter({ hasText: '读取或操作未确认' }).waitFor();
  assert.equal(await page.locator('#service-submit').isEnabled(), false, 'failed source reads cannot retain the previous application');
  assert.equal(await page.locator('#service-selection').textContent(), '');

  await connection.selectOption(github.id); await repository.fill('owner/repo');
  const lateSha = 'e'.repeat(40); await sha.fill(lateSha);
  let captured;
  const pending = new Promise(resolve => { captured = resolve; });
  auth.intercept = async route => {
    const body = route.request().postDataJSON();
    if (!route.request().url().endsWith('/application') || body?.sourceSha !== lateSha) return false;
    await new Promise(resolve => { release = resolve; captured(); });
    auth.intercept = null;
    const response = await suite.f.mf.dispatchFetch(route.request().url(), { method: 'POST',
      headers: { ...route.request().headers(), 'cf-access-jwt-assertion': auth.token }, body: route.request().postData() });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    return true;
  };
  await read.click(); await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('source read was not captured')), 10000).unref())]);
  assert.equal(await read.isEnabled(), false);
  await page.locator('#service-close').click(); await page.locator('#service-add').click();
  await page.locator('#service-selection').filter({ hasText: 'v2.0.0' }).waitFor();
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/application') && response.request().postDataJSON()?.sourceSha === lateSha);
  release(); release = null;
  await (await lateResponse).finished();
  assert.equal(await page.locator('#service-version').inputValue(), updatedSha, 'a late closed-dialog response cannot replace the reopened selection');
  assert.equal(await sha.inputValue(), '', 'closing clears the source draft');

  await page.getByRole('button', { name: '指定来源', exact: true }).click();
  await connection.selectOption(github.id); await repository.fill('owner/repo'); await sha.fill(updatedSha);
  await read.click(); await page.locator('#service-selection').filter({ hasText: 'v2.0.0' }).waitFor();
  await page.setViewportSize({ width: 320, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/service-source-synthetic-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/service-source-synthetic-desktop.png', fullPage: true });
  auth.token = suite.f.jwt({ email: 'denied@example.invalid' });
  await read.click(); await page.locator('#service-notice').filter({ hasText: '身份验证失败' }).waitFor();
  assert.equal(await page.locator('#service-dialog').isVisible(), false);
  assert.equal(await sha.inputValue(), '');
  assert.equal(state.dispatches, 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  console.log('PASS EMAIL-03 pinned source: absent default branch, account connection and exact SHA, immutable plan, no implicit connection/dispatch, scope rejection, late close response, 320px, owner expiry and draft cleanup');
} finally { release?.(); await suite.close(); }
