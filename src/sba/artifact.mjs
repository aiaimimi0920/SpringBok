import { createGithubExecutor } from './github.mjs';
import { readSbaReceipt } from './receipt.mjs';
const reject = () => { throw new Error('SBA_ARTIFACT_REJECTED'); };

export async function recoverSbaReceipt(configuration, job, { token, fetchImpl = fetch } = {}) {
  const executor = createGithubExecutor(configuration, { token, fetchImpl });
  const outcome = await executor.inspectRun(job.runId, job.request, job.manifest);
  if (outcome.status !== 'receipt-available') return outcome;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const endpoint = `https://api.github.com/repos/${configuration.repository}/actions/artifacts/${outcome.artifact.id}/zip`;
    const response = await fetchImpl(endpoint, { redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10', 'user-agent': 'SpringBok-SBA' } });
    await response.body?.cancel();
    if (response.status !== 302) reject();
    const url = new URL(response.headers.get('location'));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
        !/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)) reject();
    // 绝不向签名制品存储转发 GitHub bearer；不允许二次重定向。
    const download = await fetchImpl(url.href, { redirect: 'manual', signal: controller.signal });
    if (download.status !== 200 || !download.body) { await download.body?.cancel(); reject(); }
    const reader = download.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 65536) reject(); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const envelope = await readSbaReceipt(bytes, { digest: outcome.artifact.digest, runId: job.runId,
      request: job.request, executorSha: configuration.executorSha, requestDigest: job.requestDigest, permitId: job.permitId });
    return { status: 'verified-receipt', envelope };
  } catch { reject(); }
  finally { clearTimeout(timer); controller.abort(); }
}
