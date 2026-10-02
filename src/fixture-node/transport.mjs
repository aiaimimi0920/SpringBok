// Core is reachable only inside the dedicated Compose network. No URL input.
export async function fixtureTransport(password, { fetcher = fetch, provision = false } = {}) {
  if (typeof password !== 'string' || !/^[a-f0-9]{64}$/.test(password)) throw new Error('invalid fixture credential');
  let jwt;
  if (typeof provision !== 'boolean') throw new Error('invalid fixture mode');
  const paths = new Set(['read/GetVersion', 'read/GetServerState', 'read/GetDeployment', 'write/UpdateDeployment', 'execute/Deploy', 'read/GetUpdate', 'read/InspectDeploymentContainer']);
  if (provision) { paths.clear(); for (const path of ['read/GetServer', 'read/GetServerState', 'write/CreateDeployment']) paths.add(path); }
  async function request(path, params, signal = AbortSignal.timeout(5000)) {
    const response = await fetcher(`http://core:9120/${path}`, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', ...(jwt ? { authorization: jwt } : {}) }, body: JSON.stringify(params) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('fixture Core unavailable'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw new Error('large Core response'); chunks.push(value); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    finally { await reader.cancel().catch(() => {}); }
  }
  const auth = await request('auth/login/LoginLocalUser', { username: 'springbok-node', password }); password = undefined;
  if (auth.type !== 'Jwt' || typeof auth.data?.jwt !== 'string' || auth.data.jwt.length > 16384) throw new Error('fixture login unavailable'); jwt = auth.data.jwt;
  return Object.freeze({ call(path, params, { signal } = {}) { if (!paths.has(path)) throw new Error('fixture API denied'); return request(path, params, signal); } });
}
