import assert from 'node:assert/strict';
import { heartbeatTransition, heartbeatResult } from '../cloud/heartbeat-contract.mjs';
import { responseJson } from './node-daemon-fixture.mjs';

// 合成进程测试仍严格使用真实协议，不把身份/任务响应当心跳响应。
export function heartbeatResponder(credential) {
  let state = { execute: null, observe: null };
  return request => {
    const path = new URL(request.url).pathname, prefix = `/node/v2/heartbeat/${credential.role}/${credential.ownerId}/${credential.nodeId}/${credential.enrollmentId}/`;
    if (!path.startsWith('/node/v2/heartbeat/')) return null;
    assert.ok(path.startsWith(prefix)); assert.equal(request.init.headers.authorization, `Bearer ${credential.token}`);
    const operation = path.slice(prefix.length), input = JSON.parse(request.init.body);
    const next = heartbeatTransition(state, credential.role, operation, input, Date.now()); state = next.state;
    return responseJson(heartbeatResult({ ownerId: credential.ownerId, nodeId: credential.nodeId }, credential.enrollmentId, credential.role, next.result));
  };
}
