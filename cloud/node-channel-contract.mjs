import { exact } from './protocol.mjs';
import { nodeContext, nodePlan, probeReceipt } from './node-protocol.mjs';
import { isUuid } from './catalog-contract.mjs';
import { identityRequest, requireCredential } from './credential-contract.mjs';

export function channelInput(operation, value) {
  requireCredential(['poll', 'report'].includes(operation));
  return operation === 'poll' ? identityRequest(value) : probeReceipt(value);
}
export function channelResult(context, enrollmentId, result) {
  requireCredential(isUuid(enrollmentId));
  return { protocolVersion: 2, ...nodeContext(context), enrollmentId, role: 'execute', executionReady: false, result };
}
export function verifyChannelResult(value, credential, operation, receipt = null) {
  exact(value, ['protocolVersion', 'ownerId', 'nodeId', 'enrollmentId', 'role', 'executionReady', 'result']);
  requireCredential(value.protocolVersion === 2 && value.ownerId === credential.ownerId && value.nodeId === credential.nodeId && value.enrollmentId === credential.enrollmentId && value.role === 'execute' && credential.role === 'execute' && value.executionReady === false);
  const result = value.result;
  if (operation === 'report') {
    exact(result, ['status', 'requestId']);
    requireCredential(result.requestId === receipt.requestId && ['observed', 'unknown'].includes(result.status) && (result.status === 'unknown' || result.status === receipt.outcome));
  } else {
    requireCredential(operation === 'poll');
    if (result.status === 'delivery') {
      exact(result, ['status', 'input']);
      return { status: 'delivery', input: nodePlan(result.input, { ownerId: credential.ownerId, nodeId: credential.nodeId }) };
    }
    exact(result, result.status === 'idle' ? ['status'] : ['status', 'requestId']);
    requireCredential(['idle', 'claimed', 'unknown', 'expired'].includes(result.status) && (result.status === 'idle' || isUuid(result.requestId)));
  }
  return structuredClone(result);
}
