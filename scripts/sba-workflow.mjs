import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { devNull } from 'node:os';
import { pathToFileURL } from 'node:url';
import { inspectCheckout, executeCheckout } from '../src/sba/runner.mjs';
import { canonicalSba, sbaDigest } from '../cloud/sba-control.mjs';
import { requestSource, decodeSourceResponse } from '../src/sba/source.mjs';
const reject = () => { throw new Error('SBA_WORKFLOW_REJECTED'); };

export async function workflowInput(env) {
  const sha = env.SBA_EXECUTOR_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha) || env.GITHUB_SHA !== sha || env.GITHUB_WORKFLOW_SHA !== sha ||
      env.GITHUB_REF !== `refs/tags/sba-executor-${sha}` || env.GITHUB_REF_TYPE !== 'tag' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_RUN_ATTEMPT !== '1' ||
      env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
      env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/.github/workflows/sba-execute.yml@${env.GITHUB_REF}` ||
      typeof env.SBA_REQUEST_JSON !== 'string' || Buffer.byteLength(env.SBA_REQUEST_JSON) > 49152 ||
      !/^[a-f0-9]{64}$/.test(env.SBA_REQUEST_SHA256)) reject();
  if (await sbaDigest(env.SBA_REQUEST_JSON) !== env.SBA_REQUEST_SHA256) reject();
  const request = JSON.parse(env.SBA_REQUEST_JSON);
  if (!['deploy', 'update', 'verify', 'preview', 'destroy-preview'].includes(request.action) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.repository) ||
      !/^[a-f0-9]{40}$/.test(request.sourceSha) || !/^[a-z][a-z0-9-]{1,62}$/.test(request.taskId)) reject();
  const origin = new URL(env.SBA_RUNNER_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.SBA_RUNNER_ORIGIN || origin.username || origin.password) reject();
  return { request, endpoint: `${origin.origin}/sba/v2/permit`, executorSha: sha, runId: Number(env.GITHUB_RUN_ID) };
}
async function readJson(url, options, fetchImpl) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); reject(); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 524288) reject(); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { clearTimeout(timer); controller.abort(); }
}
function git(args, cwd, environment, input) {
  const env = { PATH: environment.PATH ?? environment.Path, SYSTEMROOT: environment.SYSTEMROOT ?? environment.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull, GIT_TERMINAL_PROMPT: '0' };
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env, input, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
async function checkoutApplication({ request, directory, environment, executorSha, authorizeSource }) {
  if (git(['rev-parse', 'HEAD'], environment.GITHUB_WORKSPACE, environment) !== executorSha) reject();
  const source = await decodeSourceResponse(await authorizeSource(), request.sourceSha);
  const checkout = join(directory, 'application'); await mkdir(checkout);
  git(['init', '--quiet'], checkout, environment);
  git(['remote', 'add', 'origin', `https://github.com/${request.repository}.git`], checkout, environment);
  await writeFile(join(checkout, '.git', 'shallow'), `${source.shallow}\n`, { encoding: 'utf8', flag: 'wx' });
  git(['unpack-objects', '--strict'], checkout, environment, source.pack);
  git(['checkout', '--quiet', '--detach', request.sourceSha], checkout, environment);
  return inspectCheckout(checkout, request);
}
export async function runSbaWorkflow({ environment = process.env, fetchImpl = fetch, checkout = checkoutApplication,
  execute = executeCheckout, tempRoot = environment.RUNNER_TEMP, onStage = () => {}, onSourceFailure = () => {} } = {}) {
  onStage('input');
  const input = await workflowInput(environment);
  onStage('workspace');
  const temporary = await realpath(tempRoot), directory = await mkdtemp(join(temporary, 'sba-workflow-'));
  let identity;
  const getIdentity = async () => {
    if (identity) return identity;
    onStage('oidc');
    const oidcUrl = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (oidcUrl.protocol !== 'https:' || oidcUrl.username || oidcUrl.password || oidcUrl.port ||
        !oidcUrl.hostname.endsWith('.actions.githubusercontent.com') || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN) reject();
    oidcUrl.searchParams.set('audience', input.endpoint);
    const response = await readJson(oidcUrl.href, { headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }, fetchImpl);
    if (typeof response.value !== 'string' || !response.value || response.value.length > 16384) reject();
    identity = response.value; return identity;
  };
  const authorizeSource = async () => {
    const token = await getIdentity(); onStage('source');
    const bytes = await requestSource(new URL('/sba/v2/source', input.endpoint).href, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: input.request.taskId, requestDigest: environment.SBA_REQUEST_SHA256 }), fetchImpl, onFailure: onSourceFailure,
    });
    onStage('checkout'); return bytes;
  };
  onStage('checkout');
  const checked = await checkout({ ...input, directory, environment, authorizeSource });
  if (canonicalSba(checked.input) !== canonicalSba(input.request)) reject();
  const token = await getIdentity();
  onStage('permit');
  // 不重试：POST 的任何丢响应都可能已经消费许可。
  const permit = await readJson(input.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: input.request.taskId, requestDigest: environment.SBA_REQUEST_SHA256 }) }, fetchImpl);
  if (!/^[a-f0-9]{64}$/.test(permit.permitId) || permit.requestDigest !== environment.SBA_REQUEST_SHA256 ||
      canonicalSba(permit.request) !== canonicalSba(input.request) || canonicalSba(permit.manifest) !== canonicalSba(checked.manifest) ||
      !permit.secrets || typeof permit.secrets !== 'object' || Array.isArray(permit.secrets) ||
      canonicalSba(Object.keys(permit.secrets).sort()) !== canonicalSba([...checked.manifest.secrets].sort()) ||
      Object.values(permit.secrets).some(value => typeof value !== 'string' || !value)) reject();
  onStage('execution');
  const execution = await execute({ checkout: checked.root, request: input.request, tempRoot: directory,
    environment: { ...environment, ...permit.secrets } });
  onStage('receipt');
  const envelope = { schemaVersion: 1, runId: input.runId, runAttempt: 1, executorSha: input.executorSha,
    requestDigest: environment.SBA_REQUEST_SHA256, permitId: permit.permitId, result: execution.result };
  // 只上传确定的回执，不上传 checkout、输入、环境或应用原始日志。
  const output = join(temporary, 'sba-receipt'); await mkdir(output);
  await writeFile(join(output, 'receipt.json'), JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return envelope;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let stage = 'platform';
  try { if (process.platform !== 'win32') reject(); await runSbaWorkflow({ onStage: value => { stage = value; },
    onSourceFailure: value => console.error(`SBA_SOURCE_DIAGNOSTIC ${JSON.stringify(value)}`) }); }
  // 只输出代码内的固定阶段名，不输出异常、Git/应用日志、输入或环境。
  catch { console.error(`SBA_WORKFLOW_UNCONFIRMED stage=${stage}`); process.exitCode = 1; }
}
