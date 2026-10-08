import { validateManifest, validateRequest } from './contract.mjs';

// 传输适配不是授权入口。调用方必须先持久化不可重放的 dispatch claim。
export class SbaGithubError extends Error {
  constructor(code) { super(code); this.name = 'SbaGithubError'; }
}
const fail = code => { throw new SbaGithubError(code); };
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');

export function createGithubExecutor(configuration, { token, fetchImpl = fetch } = {}) {
  const c = structuredClone(configuration);
  if (!c || !repoPattern.test(c.repository) || !repoPattern.test(c.applicationRepository) ||
      !positiveId(c.repositoryId) || !positiveId(c.workflowId) || !shaPattern.test(c.executorSha) ||
      typeof c.ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(c.ref) || c.ref.includes('..') ||
      typeof c.workflowPath !== 'string' || !/^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(c.workflowPath) ||
      typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail('SBA_GITHUB_CONFIGURATION_INVALID');
  const base = `https://api.github.com/repos/${c.repository}`;
  async function api(url, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'manual', signal: controller.signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
          'x-github-api-version': '2026-03-10', 'user-agent': 'SpringBok-SBA', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status !== 200 || !response.body) fail('SBA_GITHUB_RESPONSE_INVALID');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 262144) fail('SBA_GITHUB_RESPONSE_INVALID');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SBA_GITHUB_RESPONSE_INVALID');
      return value;
    } catch { fail('SBA_GITHUB_RESPONSE_INVALID'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function prepare(request, manifest) {
    let accepted;
    try { accepted = validateRequest(request, manifest); } catch { fail('SBA_GITHUB_REQUEST_INVALID'); }
    if (accepted.repository !== c.applicationRepository) fail('SBA_GITHUB_REQUEST_INVALID');
    const requestJson = JSON.stringify(canonical(accepted));
    if (new TextEncoder().encode(requestJson).byteLength > 49152) fail('SBA_GITHUB_REQUEST_INVALID');
    const requestDigest = await digest(requestJson);
    return { request: accepted, requestJson, requestDigest,
      title: `sba:${accepted.taskId}:${requestDigest}`, artifactName: `sba-result-${accepted.taskId}-${requestDigest}` };
  }
  async function readFiles(sourceSha, filenames, optional = false) {
    if (typeof sourceSha !== 'string' || !shaPattern.test(sourceSha)) fail('SBA_GITHUB_REQUEST_INVALID');
    const source = `https://api.github.com/repos/${c.applicationRepository}/git`;
    const commit = await api(`${source}/commits/${sourceSha}`);
    if (commit.sha !== sourceSha || !shaPattern.test(commit.tree?.sha)) fail('SBA_GITHUB_MANIFEST_INVALID');
    async function treeEntries(treeSha) {
      const tree = await api(`${source}/trees/${treeSha}`);
      if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) fail('SBA_GITHUB_MANIFEST_INVALID');
      return tree.tree;
    }
    function entry(entries, name, type, mode) {
      const matches = entries.filter(item => item?.path === name);
      if (matches.length !== 1 || matches[0].type !== type || matches[0].mode !== mode || !shaPattern.test(matches[0].sha))
        fail('SBA_GITHUB_MANIFEST_INVALID');
      return matches[0].sha;
    }
    // Contents API 可能解引用仓库内 symlink，必须先核对 Git tree mode。
    const root = await treeEntries(commit.tree.sha);
    if (optional && !root.some(item => item?.path === '.sba')) return null;
    const directory = await treeEntries(entry(root, '.sba', 'tree', '040000'));
    const files = {};
    for (const filename of filenames) {
      const blobSha = entry(directory, filename, 'blob', '100644');
      const file = await api(`${source}/blobs/${blobSha}`);
      try {
        if (file.sha !== blobSha || file.encoding !== 'base64' ||
            !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 65536 || typeof file.content !== 'string') throw new Error();
        const raw = atob(file.content.replace(/\n/g, ''));
        if (raw.length !== file.size) throw new Error();
        files[filename] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, ch => ch.charCodeAt(0))));
      } catch { fail('SBA_GITHUB_MANIFEST_INVALID'); }
    }
    return files;
  }
  async function readFile(sourceSha, filename) { return (await readFiles(sourceSha, [filename]))[filename]; }
  async function readManifest(sourceSha) { try { return validateManifest(await readFile(sourceSha, 'manifest.json')); } catch(error) { if(error instanceof SbaGithubError)throw error; fail('SBA_GITHUB_MANIFEST_INVALID'); } }
  async function readDeclaration(sourceSha) { return readFile(sourceSha, 'deployment.json'); }
  async function readApplication(sourceSha, optional = false) {
    const files = await readFiles(sourceSha, ['manifest.json', 'deployment.json'], optional);
    if (files === null) return null;
    try { return { manifest: validateManifest(files['manifest.json']), declaration: files['deployment.json'] }; }
    catch { fail('SBA_GITHUB_MANIFEST_INVALID'); }
  }
  async function dispatch(request, manifest) {
    const binding = await prepare(request, manifest);
    // 一次调用只有一次 POST。任何发送后错误均可能已触发，绝不降级成可重试。
    try {
      const value = await api(`${base}/actions/workflows/${c.workflowId}/dispatches`, { method: 'POST', body: {
        ref: c.ref, return_run_details: true,
        inputs: { request_json: binding.requestJson, request_sha256: binding.requestDigest, executor_sha: c.executorSha },
      } });
      if (!positiveId(value.workflow_run_id) || value.run_url !== `${base}/actions/runs/${value.workflow_run_id}` ||
          value.html_url !== `https://github.com/${c.repository}/actions/runs/${value.workflow_run_id}`) throw new Error();
      return { status: 'dispatched', runId: value.workflow_run_id, requestDigest: binding.requestDigest };
    } catch { return { status: 'unknown', runId: null, requestDigest: binding.requestDigest, errorCode: 'SBA_GITHUB_DISPATCH_UNKNOWN' }; }
  }
  async function readRun(runId, request, manifest) {
    if (!positiveId(runId)) fail('SBA_GITHUB_REQUEST_INVALID');
    const binding = await prepare(request, manifest);
    const run = await api(`${base}/actions/runs/${runId}`);
    if (run.id !== runId || run.workflow_id !== c.workflowId || run.event !== 'workflow_dispatch' ||
        run.head_sha !== c.executorSha || run.head_branch !== c.ref || run.path !== c.workflowPath || run.run_attempt !== 1 ||
        run.repository?.id !== c.repositoryId || run.repository?.full_name !== c.repository ||
        run.head_repository?.id !== c.repositoryId || run.head_repository?.full_name !== c.repository ||
        run.display_title !== binding.title || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 0) fail('SBA_GITHUB_RUN_IDENTITY_INVALID');
    return { run, binding };
  }
  async function inspectUnstartedRun(runId, request, manifest) {
    const { run, binding } = await readRun(runId, request, manifest);
    if (run.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(run.conclusion))
      fail('SBA_GITHUB_RUN_NOT_TERMINAL_FAILURE');
    // 此事实不能单独证明未执行；DO 必须在同一事务中另核许可从未消费。
    return { runId, requestDigest: binding.requestDigest, executorSha: c.executorSha,
      conclusion: run.conclusion, verifiedAt: Date.now() };
  }
  async function inspectRun(runId, request, manifest) {
    const { run, binding } = await readRun(runId, request, manifest);
    if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status) && run.conclusion === null)
      return { status: 'pending', runId, requestDigest: binding.requestDigest };
    if (run.status !== 'completed' || run.conclusion !== 'success')
      return { status: 'unknown', runId, errorCode: 'SBA_GITHUB_RUN_NOT_SUCCESSFUL' };
    const list = await api(`${base}/actions/runs/${runId}/artifacts?per_page=100`);
    if (!Number.isSafeInteger(list.total_count) || !Array.isArray(list.artifacts) || list.total_count !== list.artifacts.length ||
        list.total_count > 100) fail('SBA_GITHUB_ARTIFACT_INVALID');
    const matches = list.artifacts.filter(a => a?.name === binding.artifactName);
    if (matches.length !== 1) fail('SBA_GITHUB_ARTIFACT_INVALID');
    const artifact = matches[0];
    if (!positiveId(artifact.id) || artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes < 1 || artifact.size_in_bytes > 65536 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
        artifact.workflow_run?.id !== runId || artifact.workflow_run?.repository_id !== c.repositoryId ||
        artifact.workflow_run?.head_repository_id !== c.repositoryId || artifact.workflow_run?.head_sha !== c.executorSha ||
        artifact.workflow_run?.head_branch !== c.ref) fail('SBA_GITHUB_ARTIFACT_INVALID');
    // 这里只核实下载候选，不能把 workflow success 当作 SBA/业务成功。
    return { status: 'receipt-available', runId, requestDigest: binding.requestDigest,
      artifact: { id: artifact.id, name: artifact.name, size: artifact.size_in_bytes, digest: artifact.digest } };
  }
  return Object.freeze({ prepare, readManifest, readDeclaration, readApplication, dispatch, inspectRun, inspectUnstartedRun });
}
