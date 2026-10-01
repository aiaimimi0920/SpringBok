const allowed = new Set(['read/GetVersion', 'read/GetServer', 'read/GetServerState', 'read/GetDeployment',
  'read/GetUpdate', 'read/InspectDeploymentContainer', 'write/CreateDeployment', 'write/UpdateDeployment', 'execute/Deploy']);
// Trusted disposable-runner transport. Port is supplied only by Docker's exact
// loopback mapping in the harness, never by an HTTP client or saved user config.
export function loopbackClient(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid test Core port');
  const origin = `http://127.0.0.1:${port}`;
  let jwt;
  async function request(path, body, { signal, auth = true, text = false } = {}) {
    const response = await fetch(`${origin}/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(auth && jwt ? { authorization: jwt } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`test Core HTTP ${response.status}`); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error('test Core response too large'); } chunks.push(value); }
      const data = Buffer.concat(chunks).toString('utf8'); return text ? data : JSON.parse(data);
    } catch { throw new Error('invalid test Core response'); }
  }
  return {
    async version() { if ((await request('version', undefined, { auth: false, text: true })).trim() !== '2.3.3') throw new Error('unexpected Core version'); return true; },
    async login(password) {
      if (typeof password !== 'string' || !/^[a-f0-9]{64}$/.test(password)) throw new Error('missing temporary password');
      const result = await request('auth/login/LoginLocalUser', { username: 'springbok-ci', password }, { auth: false });
      if (result.type !== 'Jwt' || typeof result.data?.jwt !== 'string') throw new Error('unexpected test login result'); jwt = result.data.jwt;
    },
    async call(path, params, options = {}) { if (!jwt || !allowed.has(path)) throw new Error('test API not allowed'); return request(path, params, options); },
  };
}
