import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { devNull } from 'node:os';
import { pathToFileURL } from 'node:url';
import { inspectCheckout, executeCheckout } from '../src/sba/runner.mjs';
import { canonicalSba, sbaDigest } from '../cloud/sba-control.mjs';
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
  if (request.action !== 'deploy' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.repository) ||
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
function git(args, cwd, environment) {
  const env = { PATH: environment.PATH ?? environment.Path, SYSTEMROOT: environment.SYSTEMROOT ?? environment.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function checkoutApplication({ request, directory, environment, executorSha }) {
  if (git(['rev-parse', 'HEAD'], environment.GITHUB_WORKSPACE, environment) !== executorSha) reject();
  const checkout = join(directory, 'application'); await mkdir(checkout);
  git(['init', '--quiet'], checkout, environment);
  git(['remote', 'add', 'origin', `https://github.com/${request.repository}.git`], checkout, environment);
  git(['fetch', '--quiet', '--depth=1', 'origin', request.sourceSha], checkout, environment);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkout, environment);
  return inspectCheckout(checkout, request);
}
export async function runSbaWorkflow({ environment = process.env, fetchImpl = fetch, checkout = checkoutApplication,
  execute = executeCheckout, tempRoot = environment.RUNNER_TEMP } = {}) {
  const input = await workflowInput(environment);
  const temporary = await realpath(tempRoot), directory = await mkdtemp(join(temporary, 'sba-workflow-'));
  const checked = await checkout({ ...input, directory, environment });
  if (canonicalSba(checked.input) !== canonicalSba(input.request)) reject();
  const oidcUrl = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (oidcUrl.protocol !== 'https:' || oidcUrl.username || oidcUrl.password || oidcUrl.port ||
      !oidcUrl.hostname.endsWith('.actions.githubusercontent.com') || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN) reject();
  oidcUrl.searchParams.set('audience', input.endpoint);
  const identity = await readJson(oidcUrl.href, { headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }, fetchImpl);
  if (typeof identity.value !== 'string' || !identity.value || identity.value.length > 16384) reject();
  // 不重试：POST 的任何丢响应都可能已经消费许可。
  const permit = await readJson(input.endpoint, { method: 'POST', headers: { authorization: `Bearer ${identity.value}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: input.request.taskId, requestDigest: environment.SBA_REQUEST_SHA256 }) }, fetchImpl);
  if (!/^[a-f0-9]{64}$/.test(permit.permitId) || permit.requestDigest !== environment.SBA_REQUEST_SHA256 ||
      canonicalSba(permit.request) !== canonicalSba(input.request) || canonicalSba(permit.manifest) !== canonicalSba(checked.manifest) ||
      !permit.secrets || typeof permit.secrets !== 'object' || Array.isArray(permit.secrets) ||
      canonicalSba(Object.keys(permit.secrets).sort()) !== canonicalSba([...checked.manifest.secrets].sort()) ||
      Object.values(permit.secrets).some(value => typeof value !== 'string' || !value)) reject();
  const execution = await execute({ checkout: checked.root, request: input.request, tempRoot: directory,
    environment: { ...environment, ...permit.secrets } });
  const envelope = { schemaVersion: 1, runId: input.runId, runAttempt: 1, executorSha: input.executorSha,
    requestDigest: environment.SBA_REQUEST_SHA256, permitId: permit.permitId, result: execution.result };
  // 只上传确定的回执，不上传 checkout、输入、环境或应用原始日志。
  const output = join(temporary, 'sba-receipt'); await mkdir(output);
  await writeFile(join(output, 'receipt.json'), JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return envelope;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.platform !== 'win32') reject(); await runSbaWorkflow(); }
  catch { console.error('SBA_WORKFLOW_UNCONFIRMED'); process.exitCode = 1; }
}
