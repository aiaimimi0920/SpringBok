import { randomUUID } from 'node:crypto';
import { nodeCredential } from '../../cloud/credential-contract.mjs';
import { heartbeatInput, verifyHeartbeatResult } from '../../cloud/heartbeat-contract.mjs';
import { readPrivateNodeJson } from '../node-credentials/files.mjs';
import { fetchCredentialJson } from '../node-credentials/client.mjs';

export function openHeartbeatClient({ file, expectedOrigin, fetcher = fetch, bootId = randomUUID(), now = Date.now }) {
  const credential = nodeCredential(readPrivateNodeJson(file), expectedOrigin);
  heartbeatInput('start', { protocolVersion: 2, bootId, previousGeneration: 0 });
  let previousGeneration, generation, sequence = 0, pending;
  async function call(operation, input) {
    const result = await fetchCredentialJson(fetcher, `${expectedOrigin}/node/v2/heartbeat/${credential.role}/${credential.ownerId}/${credential.nodeId}/${credential.enrollmentId}/${operation}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify(heartbeatInput(operation, input)),
    });
    return verifyHeartbeatResult(result, credential, operation, input);
  }
  return Object.freeze({ async beat(signal) {
    // 启动 CAS 的输入只读一次；丢响应重送原 bootId/代次，不重新夺取别的会话。
    if (signal.aborted) return;
    if (previousGeneration === undefined) previousGeneration = (await call('read', { protocolVersion: 2 })).generation;
    if (signal.aborted) return;
    if (generation === undefined) generation = (await call('start', { protocolVersion: 2, bootId, previousGeneration })).generation;
    if (signal.aborted) return;
    pending ??= heartbeatInput('sample', { protocolVersion: 2, bootId, generation, sequence: ++sequence, sampledAt: now() });
    const result = await call('sample', pending);
    if (result.status === 'recorded') pending = undefined; // 暂时失败/限频后仍发送原样本；不伪造新的接收时间。
    return result.status;
  } });
}
