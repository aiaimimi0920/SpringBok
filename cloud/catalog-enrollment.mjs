import { catalogReceipt, MAX_CATALOG_REQUESTS } from './catalog-contract.mjs';
import { enrollmentStart, enrollmentFinalInput, enrollmentFinalId, enrollmentReceipt, catalogEnrollment, ENROLLMENT_TTL_MS, requireEnrollment } from './enrollment-contract.mjs';

export function enrollmentRows(sql, servers) {
  const rows = sql.exec('SELECT server_id,state FROM server_enrollments ORDER BY server_id').toArray();
  requireEnrollment(rows.length <= servers.length);
  return rows.map(row => {
    const record = catalogEnrollment(JSON.parse(row.state));
    requireEnrollment(row.server_id === record.serverId && servers.find(server => server.id === row.server_id)?.state === 'draft');
    return record;
  });
}
export function expandEnrollmentCatalog(sql, meta, servers) {
  if (meta.schema_version === 3) return;
  requireEnrollment(meta.schema_version === 2);
  const entries = sql.exec('SELECT request_id,input_json,result_json FROM catalog_requests').toArray();
  const revisions = new Set(entries.map(entry => catalogReceipt(entry, meta.revision).revision));
  requireEnrollment(revisions.size === meta.revision);
  sql.exec('CREATE TABLE server_enrollments (server_id TEXT PRIMARY KEY REFERENCES servers(id), state TEXT NOT NULL)');
  sql.exec('UPDATE catalog_meta SET schema_version=3 WHERE id=1');
  meta.schema_version = 3;
  enrollmentRows(sql, servers);
}
export function mutateEnrollment(sql, meta, servers, operation, value, now) {
  const input = operation === 'prepare' ? enrollmentStart(value) : enrollmentFinalInput(value);
  const id = operation === 'prepare' ? input.id : enrollmentFinalId(input.enrollmentId);
  const serialized = JSON.stringify({ resource: 'enrollment', action: operation, ...input });
  const prior = sql.exec('SELECT request_id,input_json,result_json FROM catalog_requests WHERE request_id=?', id).toArray()[0];
  if (prior) { requireEnrollment(prior.input_json === serialized); return enrollmentReceipt(prior, meta.revision); }
  requireEnrollment(Number.isSafeInteger(now) && now >= 0 && meta.revision < MAX_CATALOG_REQUESTS);
  const server = servers.find(row => row.id === input.serverId), rows = enrollmentRows(sql, servers), existing = rows.find(row => row.serverId === input.serverId);
  requireEnrollment(server?.state === 'draft');
  let record;
  if (operation === 'prepare') {
    // 每个未收尾 enrollment 预留一条 finalize 回执，其他目录写入也必须尊重此余额。
    requireEnrollment(input.revision === meta.revision && !existing && meta.revision + rows.filter(row => row.state === 'enrolling').length + 2 <= MAX_CATALOG_REQUESTS);
    record = catalogEnrollment({ serverId: input.serverId, enrollmentId: input.id, challengeDigest: input.challengeDigest, createdAt: now, expiresAt: now + ENROLLMENT_TTL_MS, updatedAt: now, state: 'enrolling' });
    sql.exec('INSERT INTO server_enrollments VALUES(?,?)', record.serverId, JSON.stringify(record));
  } else {
    requireEnrollment(operation === 'finalize' && existing?.state === 'enrolling' && existing.enrollmentId === input.enrollmentId);
    record = catalogEnrollment({ ...existing, state: 'active', updatedAt: Math.max(now, existing.updatedAt, input.joinedAt), joinRequestId: input.joinRequestId, joinedAt: input.joinedAt });
    sql.exec('UPDATE server_enrollments SET state=? WHERE server_id=?', JSON.stringify(record), record.serverId);
  }
  const result = { id, revision: meta.revision + 1, enrollment: record };
  sql.exec('UPDATE catalog_meta SET revision=? WHERE id=1', result.revision);
  sql.exec('INSERT INTO catalog_requests VALUES(?,?,?)', id, serialized, JSON.stringify(result));
  return result;
}
