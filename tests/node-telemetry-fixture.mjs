import assert from 'node:assert/strict';
import { telemetryTransition, telemetryResult } from '../cloud/telemetry-contract.mjs';
import { responseJson } from './node-daemon-fixture.mjs';
export function telemetryResponder(credential) {
  let state = null;
  return request => {
    const path = new URL(request.url).pathname, prefix = `/node/v2/telemetry/observe/${credential.ownerId}/${credential.nodeId}/${credential.enrollmentId}/`;
    if (!path.startsWith('/node/v2/telemetry/')) return null;
    assert.equal(credential.role, 'observe'); assert.ok(path.startsWith(prefix)); assert.equal(request.init.headers.authorization, `Bearer ${credential.token}`);
    const operation = path.slice(prefix.length), input = JSON.parse(request.init.body);
    const next = telemetryTransition(state, operation, input, Date.now()); state = next.state;
    return responseJson(telemetryResult({ ownerId: credential.ownerId, nodeId: credential.nodeId, enrollmentId: credential.enrollmentId }, next.result));
  };
}
