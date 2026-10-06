import enrollmentWorker from './enrollment-fixture.mjs';
import worker from '../../cloud/worker.mjs';
import { NodeTelemetry as Telemetry } from '../../cloud/telemetry-store.mjs';
import { NodeTelemetry as LegacyTelemetry } from '../fixtures/telemetry-v1/store.mjs';
import { NodeTelemetry as MemoryTelemetry } from '../fixtures/telemetry-v2/store.mjs';
import { NodeTelemetry as DiskTelemetry } from '../fixtures/telemetry-v3/store.mjs';
import { telemetryName } from '../../cloud/telemetry-contract.mjs';
export { TargetMailbox, OwnerCatalog, NodeMailbox } from './enrollment-fixture.mjs';
// 仅测试 Worker 导入；故障/挂起入口不进入生产 bundle。
export class NodeTelemetry extends Telemetry {
  failures = new Set();
  releaseWait;
  fail(stage) {
    if (this.env.TELEMETRY_FAULT === stage && !this.failures.has(stage)) { this.failures.add(stage); throw new Error('injected telemetry interruption'); }
  }
  async apply(...args) {
    if (this.env.TELEMETRY_FAULT === 'hold' && args[1] === 'sample') await new Promise(resolve => { this.releaseWait = resolve; });
    if (args[1] === 'sample') this.fail('before'); const result = this.env.TELEMETRY_READER === 'legacy' ? new LegacyTelemetry(this.ctx, this.env).apply(...args) : this.env.TELEMETRY_READER === 'memory' ? new MemoryTelemetry(this.ctx, this.env).apply(...args) : this.env.TELEMETRY_READER === 'disk' ? new DiskTelemetry(this.ctx, this.env).apply(...args) : super.apply(...args); if (args[1] === 'sample') this.fail('after'); return result;
  }
  snapshot(...args) { return this.env.TELEMETRY_READER === 'legacy' ? new LegacyTelemetry(this.ctx, this.env).snapshot(...args) : this.env.TELEMETRY_READER === 'memory' ? new MemoryTelemetry(this.ctx, this.env).snapshot(...args) : this.env.TELEMETRY_READER === 'disk' ? new DiskTelemetry(this.ctx, this.env).snapshot(...args) : super.snapshot(...args); }
  waiting() { return !!this.releaseWait; }
  release() { this.releaseWait?.(); this.releaseWait = undefined; return null; }
  inspect() {
    return this.ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('telemetry_meta','telemetry_state') ORDER BY name").toArray().map(table => ({ ...table, rows: this.ctx.storage.sql.exec(`SELECT * FROM ${table.name}`).toArray() }));
  }
  rawApply(...args) { return super.apply(...args); }
  rawSnapshot(...args) { return super.snapshot(...args); }
  damage(kind, age = 0) {
    const sql = this.ctx.storage.sql;
    if (kind === 'table') sql.exec('DROP TABLE telemetry_state');
    else if (kind === 'meta') sql.exec('DELETE FROM telemetry_meta');
    else if (kind === 'version') sql.exec('UPDATE telemetry_meta SET schema_version=99');
    else if (kind === 'schema-two') sql.exec('UPDATE telemetry_meta SET schema_version=2');
    else if (kind === 'schema-three') sql.exec('UPDATE telemetry_meta SET schema_version=3');
    else if (kind === 'schema-one') sql.exec('UPDATE telemetry_meta SET schema_version=1');
    else if (kind === 'upgrade-write') sql.exec("CREATE TRIGGER upgrade_fault BEFORE UPDATE ON telemetry_state BEGIN SELECT RAISE(ABORT, 'injected state write failure'); END");
    else if (kind === 'remove-upgrade-write') sql.exec('DROP TRIGGER upgrade_fault');
    else if (kind === 'owner') sql.exec("UPDATE telemetry_meta SET owner_id=?", 'b'.repeat(64));
    else if (kind === 'record') sql.exec("UPDATE telemetry_state SET state='{}'");
    else if (kind === 'age') {
      if (!Number.isSafeInteger(age) || age < 0) throw new Error('invalid age');
      const state = JSON.parse(sql.exec('SELECT state FROM telemetry_state').one().state);
      state.latest.receivedAt = Date.now() - age; state.startedAt = Math.min(state.startedAt, state.latest.receivedAt);
      sql.exec('UPDATE telemetry_state SET state=?', JSON.stringify(state));
    } else throw new Error('unknown damage');
    return null;
  }
}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__telemetry_http') {
    // 绕过测试客户端的 Content-Length transport 校验，仅测试 Worker reader。
    const { path, headers, body } = await request.json();
    return worker.fetch(new Request(new URL(path, request.url), { method: 'POST', headers, body }), env);
  }
  if (new URL(request.url).pathname !== '/__telemetry_fixture') return enrollmentWorker.fetch(request, env);
  try {
    const { context, operation, args = [] } = await request.json();
    if (!['inspect', 'damage', 'waiting', 'release', 'rawApply', 'rawSnapshot'].includes(operation)) throw new Error('unknown test method');
    return Response.json(await env.TELEMETRY.get(env.TELEMETRY.idFromName(telemetryName(context)))[operation](...args));
  } catch { return new Response(null, { status: 409 }); }
} };
