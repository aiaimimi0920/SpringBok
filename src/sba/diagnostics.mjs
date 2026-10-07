// 诊断只接受固定枚举和 HTTP 数字；不转发错误、headers、claims 或响应正文。
const phases = new Set(['policy', 'request', 'oidc', 'body', 'pending', 'run', 'source', 'secrets', 'permit']);
const reasons = new Set(['rejected', 'token', 'jwt', 'subject', 'time', 'repository', 'executor', 'context', 'run-id',
  'http', 'media', 'body-missing', 'body-empty', 'body-size', 'body-read', 'network']);
const status = value => Number.isInteger(Number(value)) && Number(value) >= 200 && Number(value) <= 599 ? Number(value) : null;
export const sbaFailureReason = value => reasons.has(value) ? value : 'rejected';
export function sourceMedia(value) {
  const type = value?.split(';')[0]?.trim().toLowerCase();
  return new Map([['application/x-git-upload-pack-result', 'git'], ['application/json', 'json'],
    ['text/html', 'html'], ['text/plain', 'text']]).get(type) ?? (type ? 'other' : 'missing');
}
export function sbaDiagnosticHeaders({ phase, reason, httpStatus = null, media = null }) {
  return { 'x-sba-denied-phase': phases.has(phase) ? phase : 'request',
    'x-sba-denied-reason': sbaFailureReason(reason),
    ...(status(httpStatus) ? { 'x-sba-upstream-status': String(status(httpStatus)) } : {}),
    ...(['git', 'json', 'html', 'text', 'other', 'missing'].includes(media) ? { 'x-sba-upstream-media': media } : {}) };
}
export function sourceDiagnostic(response, reason) {
  const phase = response?.headers.get('x-sba-denied-phase');
  const remoteMedia = response?.headers.get('x-sba-upstream-media');
  return { reason: sbaFailureReason(reason), httpStatus: status(response?.status),
    media: sourceMedia(response?.headers.get('content-type')),
    remotePhase: phases.has(phase) ? phase : null,
    remoteReason: sbaFailureReason(response?.headers.get('x-sba-denied-reason')),
    upstreamStatus: status(response?.headers.get('x-sba-upstream-status')),
    upstreamMedia: ['git', 'json', 'html', 'text', 'other', 'missing'].includes(remoteMedia) ? remoteMedia : null };
}
