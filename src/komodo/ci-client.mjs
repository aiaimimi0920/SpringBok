import { KOMODO_VERSION } from './mapping.mjs';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const allowed = new Set(['read/GetVersion', 'read/GetServer', 'read/GetServerState', 'read/GetDeployment', 'read/GetProcedure',
  'read/GetUpdate', 'read/InspectDeploymentContainer', 'write/CreateDeployment', 'write/UpdateDeployment',
  'write/CreateProcedure', 'execute/Deploy', 'execute/RunProcedure']);
// Disposable CI client only: fixed URL and endpoint allowlist. Params are trusted
// harness input, NOT an authorization layer or an AI-callable executor.
export function ciClient() {
  let jwt;
  async function request(path, body, authenticated = true) {
    const response = await fetch(`http://core:9120/${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(authenticated && jwt ? { authorization: jwt } : {}) },
      body: JSON.stringify(body),
    });
    // Never include server error bodies, request params, passwords or JWT in logs.
    if (!response.ok) throw new Error(`Komodo ${path} HTTP ${response.status}`);
    return response.json();
  }
  return {
    async login(password) {
      if (typeof password !== 'string' || password.length < 32) throw new Error('missing ephemeral password');
      const result = await request('auth/login/LoginLocalUser', { username: 'springbok-ci', password }, false);
      if (result.type !== 'Jwt' || typeof result.data?.jwt !== 'string') throw new Error('unexpected login response');
      jwt = result.data.jwt;
    },
    async call(path, params = {}) {
      if (!jwt || !allowed.has(path)) throw new Error('API operation not permitted');
      return request(path, params);
    },
    async version() {
      const response = await fetch('http://core:9120/version', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Core version HTTP ${response.status}`);
      const version = (await response.text()).trim();
      if (version !== KOMODO_VERSION) throw new Error('unexpected Core version');
      return KOMODO_VERSION;
    },
  };
}
export async function waitFor(check, label, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch { /* bounded retry, no sensitive error bodies */ }
    await sleep(1000);
  }
  throw new Error(`Timed out: ${label}`);
}
export async function completedUpdate(client, initial, type, target) {
  const id = initial?._id?.$oid;
  if (!/^[a-f0-9]{24}$/.test(id || '')) throw new Error('missing execution ID');
  const final = await waitFor(async () => {
    const update = await client.call('read/GetUpdate', { id });
    return update.status === 'Complete' ? update : null;
  }, `${type} completion`);
  if (final._id?.$oid !== id || final.operation !== type || final.target?.id !== target || final.target?.type !== (type === 'RunProcedure' ? 'Procedure' : 'Deployment') || final.success !== true) {
    throw new Error(`${type} execution failed or mismatched`);
  }
  return id;
}

// Komodo 2.3.3 preserves Docker's PascalCase inspection JSON (serde rename).
export function containerMatches(container, image, healthy = true) {
  if (!container || container.Image !== image) return false;
  const state = container.State;
  if (healthy) return state?.Status === 'running' && state.Running === true &&
    state.Paused === false && state.OOMKilled === false && state.Health?.Status === 'healthy';
  return state?.Status === 'exited' && state.Running === false &&
    state.OOMKilled === false && state.Paused === false && state.ExitCode === 1;
}
