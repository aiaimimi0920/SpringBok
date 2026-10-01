import { digest } from '../execution/plan.mjs';

// Fixed trusted catalog only. Never discover servers or accept caller targets.
export function createReadinessCheck(releases, transport, timeoutMs) {
  const targets = new Map();
  for (const release of releases) for (const role of ['test', 'production']) {
    const target = release[role];
    if (!targets.has(target.id)) targets.set(target.id, { service: release.service, role, id: target.id, name: target.name, variants: new Map() });
    targets.get(target.id).variants.set(digest(target.config), { artifact: release.artifact, serverId: target.config.server_id });
  }
  if (targets.size !== 8) throw new Error('eight fixed resources required');
  return async function check(recordStates, signal) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(15000, timeoutMs * 3));
    const cancelled = () => { if (signal?.aborted) throw new Error('readiness cancelled'); };
    async function read(path, params) {
      cancelled();
      if (deadline.signal.aborted) return { code: 'timeout' };
      const request = new AbortController();
      const callTimer = setTimeout(() => request.abort(), timeoutMs);
      const combined = AbortSignal.any([deadline.signal, request.signal, ...(signal ? [signal] : [])]);
      let onAbort;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => { cancelled(); if (combined.aborted) throw new Error('read aborted'); return transport.call(path, params, { signal: combined }); }),
          new Promise((_, reject) => { onAbort = () => reject(new Error('read aborted')); combined.addEventListener('abort', onAbort, { once: true }); if (combined.aborted) onAbort(); }),
        ]);
        cancelled(); return { value };
      } catch {
        cancelled(); return { code: combined.aborted ? 'timeout' : 'unavailable' };
      } finally { clearTimeout(callTimer); combined.removeEventListener('abort', onAbort); }
    }
    try {
      const rows = [];
      for (const target of targets.values()) {
        cancelled();
        const row = { service: target.service, role: target.role, id: target.id, name: target.name,
          recordState: recordStates[target.service], resource: 'unavailable', artifact: null, serverId: null, server: 'not-checked' };
        const response = await read('read/GetDeployment', { deployment: target.id });
        if (response.code) row.resource = response.code;
        else if (!response.value) row.resource = 'missing';
        else if (response.value._id?.$oid !== target.id || response.value.name !== target.name) row.resource = 'identity-mismatch';
        else {
          let variant;
          try { variant = target.variants.get(digest(response.value.config)); } catch { /* unknown full configuration */ }
          if (variant) { row.resource = 'matched'; row.artifact = variant.artifact; row.serverId = variant.serverId; }
          else row.resource = 'configuration-unknown';
        }
        rows.push(row);
      }
      const servers = new Map();
      for (const row of rows) if (row.serverId && !servers.has(row.serverId)) {
        const response = await read('read/GetServerState', { server: row.serverId });
        // v2.3.3 returns cached status only, with no freshness timestamp or echoed ID.
        servers.set(row.serverId, response.code || (new Map([['Ok', 'cached-ok'], ['NotOk', 'cached-not-ok'], ['Disabled', 'cached-disabled']]).get(response.value?.status) || 'unknown'));
      }
      cancelled();
      for (const row of rows) if (row.serverId) row.server = servers.get(row.serverId);
      return { observedAt: new Date().toISOString(), executionReady: false, approvalGranted: false,
        observation: rows.every(r => r.resource === 'matched' && r.server === 'cached-ok' && r.recordState === 'no-pending-record') ? 'matched' : 'attention', rows };
    } finally { clearTimeout(timer); }
  };
}
