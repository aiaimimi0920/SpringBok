// 仅固定官方 GET。错误不带 token、上游 body、URL 或账号名称。
export async function readJson(url, token, github, transport = fetch, timeoutMs = 8000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await transport(url, { method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'SpringBok-Connections/1.0',
        ...(github ? { 'x-github-api-version': '2022-11-28' } : {}) } });
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
      await response.body?.cancel(); throw new Error('provider denied');
    }
    reader = response.body.getReader(); const chunks = []; let size = 0;
    // Abort fetch also closes its body; the explicit race covers a stalled custom stream.
    const deadline = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(new Error('timeout'));
      else controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); reject(new Error('timeout')); }, { once: true });
    });
    const read = async () => {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 262144) throw new Error('response too large'); chunks.push(value); }
      if (controller.signal.aborted) throw new Error('timeout');
      const buffer = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    };
    return await Promise.race([read(), deadline]);
  } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}
export async function verifyConnection(row, token, transport = fetch, timeoutMs = 8000) {
  try {
    if (row.provider === 'cloudflare') {
      const result = await readJson(`https://api.cloudflare.com/client/v4/accounts/${row.target}`, token, false, transport, timeoutMs);
      if (result.success !== true || result.result?.id !== row.target) throw new Error('account mismatch');
      return { ok: true, code: 'account-read' };
    }
    if (row.provider !== 'github') throw new Error('unsupported provider');
    const user = await readJson('https://api.github.com/user', token, true, transport, timeoutMs);
    if (!Number.isSafeInteger(user.id) || user.id < 1) throw new Error('invalid PAT');
    if (row.target.startsWith('@')) {
      if (row.target !== '@' + user.login) throw new Error('account mismatch');
      return { ok:true, code:'github-account-read' };
    }
    const repo = await readJson(`https://api.github.com/repos/${row.target}`, token, true, transport, timeoutMs);
    if (repo.full_name?.toLowerCase() !== row.target.toLowerCase() || !Number.isSafeInteger(repo.id) || repo.id < 1 || repo.archived === true || repo.disabled === true) throw new Error('repository mismatch');
    const actions = await readJson(`https://api.github.com/repos/${row.target}/actions/workflows?per_page=1`, token, true, transport, timeoutMs);
    if (!Number.isSafeInteger(actions.total_count) || actions.total_count < 0 || !Array.isArray(actions.workflows)) throw new Error('actions unavailable');
    return { ok: true, code: 'repository-actions-read' };
  } catch { return { ok: false, code: 'verification-failed' }; }
}
