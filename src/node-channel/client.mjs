import { nodeCredential, requireCredential } from '../../cloud/credential-contract.mjs';
import { channelInput, verifyChannelResult } from '../../cloud/node-channel-contract.mjs';
import { readPrivateNodeJson } from '../node-credentials/files.mjs';
import { readCredentialResponse } from '../node-credentials/client.mjs';

export function openNodeChannelClient({ file, expectedOrigin, fetcher = fetch }) {
  const credential = nodeCredential(readPrivateNodeJson(file), expectedOrigin);
  requireCredential(credential.role === 'execute');
  const context = Object.freeze({ origin: expectedOrigin, ownerId: credential.ownerId, nodeId: credential.nodeId, enrollmentId: credential.enrollmentId, role: credential.role });
  return Object.freeze({ context, async call(operation, value) {
    const input = channelInput(operation, value);
    const response = await fetcher(`${expectedOrigin}/node/v2/channel/execute/${credential.ownerId}/${credential.nodeId}/${credential.enrollmentId}/${operation}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return verifyChannelResult(await readCredentialResponse(response), credential, operation, operation === 'report' ? input : null);
  } });
}
