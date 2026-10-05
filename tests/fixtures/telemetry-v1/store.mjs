import { DurableObject } from 'cloudflare:workers';
import { telemetryContext, telemetryName, authorizedTelemetry, telemetryState, telemetryTransition, telemetryResult, telemetrySnapshot, requireTelemetry } from './contract.mjs';

export class NodeTelemetry extends DurableObject {
  #context(value) {
    const context = telemetryContext(value);
    requireTelemetry(this.env.ENABLE_NODE_MAILBOX === 'yes' && this.env.ENABLE_NODE_CREDENTIALS === 'yes' && this.env.ENABLE_NODE_TELEMETRY === 'yes' && this.env.TELEMETRY && this.ctx.id.toString() === this.env.TELEMETRY.idFromName(telemetryName(context)).toString());
    return context;
  }
  #read(context) {
    const sql = this.ctx.storage.sql, tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    if (!tables.length) return { initialized: false, state: null };
    requireTelemetry(tables.length === 2 && ['telemetry_meta', 'telemetry_state'].every(name => tables.some(row => row.name === name)));
    const meta = sql.exec('SELECT * FROM telemetry_meta').toArray(), rows = sql.exec('SELECT * FROM telemetry_state').toArray();
    requireTelemetry(meta.length === 1 && meta[0].id === 1 && meta[0].schema_version === 1 && meta[0].owner_id === context.ownerId && meta[0].node_id === context.nodeId && meta[0].enrollment_id === context.enrollmentId && rows.length === 1 && rows[0].id === 1);
    const state = telemetryState(JSON.parse(rows[0].state)); requireTelemetry(state !== null);
    return { initialized: true, state };
  }
  apply(authorization, operation, input) {
    const context = this.#context(authorizedTelemetry(authorization));
    return this.ctx.storage.transactionSync(() => {
      this.#context(context);
      const current = this.#read(context), result = telemetryTransition(current.state, operation, input, Date.now()), sql = this.ctx.storage.sql;
      if (result.changed) {
        if (!current.initialized) {
          sql.exec('CREATE TABLE telemetry_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, owner_id TEXT NOT NULL, node_id TEXT NOT NULL, enrollment_id TEXT NOT NULL)');
          sql.exec('CREATE TABLE telemetry_state (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
          sql.exec('INSERT INTO telemetry_meta VALUES(1,1,?,?,?)', context.ownerId, context.nodeId, context.enrollmentId);
          sql.exec('INSERT INTO telemetry_state VALUES(1,?)', JSON.stringify(result.state));
        } else sql.exec('UPDATE telemetry_state SET state=? WHERE id=1', JSON.stringify(result.state));
      }
      return telemetryResult(context, result.result);
    });
  }
  snapshot(value) {
    const context = this.#context(value);
    return this.ctx.storage.transactionSync(() => telemetrySnapshot({ ownerId: context.ownerId, nodeId: context.nodeId }, this.#read(context).state, Date.now()));
  }
}
