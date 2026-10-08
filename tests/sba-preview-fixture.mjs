export const previewManifest = () => ({ schemaVersion: 3, id: 'sample-app', name: 'Sample', version: '2.0.0', entrypoint: 'entry.ps1',
  runtime: { runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' },
  actions: Object.fromEntries(['deploy', 'update', 'verify', 'preview', 'destroy-preview'].map(action => [action, { timeoutSeconds: 60 }])), secrets: [] });
export const inventory = suffix => [{ key: 'worker', kind: 'worker', accountId: 'a'.repeat(32), remoteId: 'worker-' + suffix, name: 'worker-' + suffix },
  { key: 'domain', kind: 'domain', accountId: 'a'.repeat(32), remoteId: `https://worker-${suffix}.example.invalid`, name: `https://worker-${suffix}.example.invalid` }];
export function previewRequest() {
  return { schemaVersion: 3, taskId: 'dc-' + '2'.repeat(32), action: 'preview', repository: 'example/application', sourceSha: 'b'.repeat(40),
    applicationId: 'sample-app', applicationVersion: '2.0.0', environment: 'test-instance', configuration: {},
    previous: { sourceSha: 'a'.repeat(40), applicationVersion: '1.0.0' },
    context: { source: { instanceId: 'dc-' + '1'.repeat(32), taskId: 'dc-' + '1'.repeat(32), sourceSha: 'a'.repeat(40), applicationVersion: '1.0.0',
      environment: 'production', configuration: {}, resources: inventory('production'), resultDigest: 'd'.repeat(64) },
    resources: inventory('test'), urls: ['https://worker-test.example.invalid'] } };
}
export function previewResult(request = previewRequest()) {
  return { schemaVersion: 3, taskId: request.taskId, action: request.action, sourceSha: request.sourceSha, applicationVersion: request.applicationVersion,
    status: 'succeeded', checks: ['snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated'].map(id => ({ id, passed: true })),
    lifecycle: { resources: request.context.resources.map(row => ({ key: row.key, status: 'created' })), urls: request.context.urls,
      snapshot: { id: 'e'.repeat(64), createdAt: 1791459200000 } } };
}
