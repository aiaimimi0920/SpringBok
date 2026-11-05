import { readJson } from './connections-provider.mjs';
import { requireSba, sbaDigest, canonicalSba } from './sba-control.mjs';

const endpoint = (row, suffix = '') => `https://api.cloudflare.com/client/v4/accounts/${row.accountId}/r2/buckets/${encodeURIComponent(row.remoteId)}${suffix}`;
export const deletionBucketName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value);

// Bucket names are reusable identities. Never equate a newly created bucket with the reviewed one.
async function metadata(row, token, transport) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${row.accountId}/r2/buckets?per_page=1000&name_contains=${encodeURIComponent(row.remoteId)}`;
  const body = await readJson(url, token, false, transport);
  requireSba(body.success === true && Array.isArray(body.result?.buckets) && body.result.buckets.length <= 1000 && !body.result_info?.cursor);
  const matches = body.result.buckets.filter(bucket => bucket.name === row.remoteId);
  requireSba(matches.length <= 1);
  if (!matches.length) return null;
  const bucket = matches[0];
  requireSba(bucket.name === row.name && (!bucket.jurisdiction || bucket.jurisdiction === 'default') && typeof bucket.creation_date === 'string' && Number.isFinite(Date.parse(bucket.creation_date)));
  return bucket.creation_date;
}

async function objects(row, token, transport) {
  // One bounded batch: never launch a background prefix job or silently approve unlisted objects.
  const body = await readJson(endpoint(row, '/objects?per_page=1000'), token, false, transport);
  requireSba(body.success === true && Array.isArray(body.result) && body.result.length <= 1000 && body.result_info?.is_truncated === false);
  const entries = body.result.map(item => {
    requireSba(typeof item.key === 'string' && item.key.length > 0 && new TextEncoder().encode(item.key).length <= 1024);
    requireSba(Number.isSafeInteger(item.size) && item.size >= 0 && typeof item.etag === 'string' && /^[a-fA-F0-9]{32}(?:-\d+)?$/.test(item.etag));
    requireSba(typeof item.last_modified === 'string' && Number.isFinite(Date.parse(item.last_modified)));
    return { key: item.key, size: item.size, etag: item.etag, modifiedAt: item.last_modified };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  requireSba(new Set(entries.map(item => item.key)).size === entries.length);
  const bytes = entries.reduce((sum, item) => sum + item.size, 0);
  requireSba(Number.isSafeInteger(bytes));
  return { keys: entries.map(item => item.key), summary: { count: entries.length, bytes, digest: await sbaDigest(entries) } };
}

async function privateUnsharedBucket(row, token, transport) {
  const get = async url => {
    const body = await readJson(url, token, false, transport);
    requireSba(body.success === true && body.result && typeof body.result === 'object');
    return body.result;
  };
  const locks = await get(endpoint(row, '/lock'));
  requireSba(Array.isArray(locks.rules) && locks.rules.length === 0);
  const custom = await get(endpoint(row, '/domains/custom'));
  requireSba(Array.isArray(custom.domains) && custom.domains.length === 0);
  const managed = await get(endpoint(row, '/domains/managed'));
  requireSba(managed.enabled === false);
  const notifications = await get(`https://api.cloudflare.com/client/v4/accounts/${row.accountId}/event_notifications/r2/${encodeURIComponent(row.remoteId)}/configuration`);
  requireSba(Array.isArray(notifications.queues) && notifications.queues.length === 0);
}

export async function inspectDeletionBucket(row, token, transport = fetch) {
  const createdAt = await metadata(row, token, transport);
  if (createdAt === null) return { ...row, present: false };
  await privateUnsharedBucket(row, token, transport);
  const snapshot = await objects(row, token, transport);
  // Do not expose object keys, message subjects, custom metadata or contents in a public plan.
  return { ...row, present: true, createdAt, objects: snapshot.summary };
}

export async function deletionBucketAbsent(row, token, transport = fetch) {
  return await metadata(row, token, transport) === null;
}

async function deleteJson(url, token, body, transport) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  requireSba(serialized === undefined || new TextEncoder().encode(serialized).length <= 262144);
  const result = await readJson(url, token, false, (target, options) => transport(target, { ...options, method: 'DELETE',
    headers: { ...options.headers, 'content-type': 'application/json' }, ...(serialized === undefined ? {} : { body: serialized }) }));
  // Bulk deletes may return HTTP 200 with success:false after partially deleting objects.
  requireSba(result.success === true && Array.isArray(result.errors) && result.errors.length === 0);
  return result.result;
}

export async function removeDeletionBucket(row, token, transport = fetch) {
  requireSba(await metadata(row, token, transport) === row.createdAt);
  await privateUnsharedBucket(row, token, transport);
  const snapshot = await objects(row, token, transport);
  requireSba(canonicalSba(snapshot.summary) === canonicalSba(row.objects));
  if (snapshot.keys.length) {
    const removed = await deleteJson(endpoint(row, '/objects'), token, snapshot.keys, transport);
    requireSba(Array.isArray(removed) && removed.length === snapshot.keys.length && canonicalSba(removed.map(item => item.key).sort()) === canonicalSba([...snapshot.keys].sort()));
  }
  // A concurrent writer must not cause a second clearing pass; preserve it and stop as unknown.
  requireSba((await objects(row, token, transport)).summary.count === 0);
  requireSba(await metadata(row, token, transport) === row.createdAt);
  await deleteJson(endpoint(row), token, undefined, transport);
}
