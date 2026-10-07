import { DurableObject } from 'cloudflare:workers';
import { connectionInput, connectionMetadata, ownerId, validVaultKey } from './connections-contract.mjs';
import { connectionDigest, sealToken, openToken } from './connections-crypto.mjs';
import { verifyConnection } from './connections-provider.mjs';

export class ConnectionVault extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  guard(owner) {
    ownerId(owner);
    if (this.env.ENABLE_CONNECTIONS !== 'yes' || !validVaultKey(this.env.CONNECTIONS_ENCRYPTION_KEY)) throw new Error('vault disabled');
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('connection_owner','connections')").toArray();
    if (tables.length === 0) {
      sql.exec('CREATE TABLE connection_owner (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL)');
      sql.exec('CREATE TABLE connections (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, sealed TEXT NOT NULL, digest TEXT NOT NULL)');
      sql.exec('INSERT INTO connection_owner(id,owner) VALUES(1,?)', owner);
    }
    const rows = sql.exec('SELECT owner FROM connection_owner WHERE id=1').toArray();
    if (rows.length !== 1 || rows[0].owner !== owner) throw new Error('owner mismatch');
    // 不在已有 owner 下重建丢失的表。
    sql.exec('SELECT id FROM connections LIMIT 1').toArray();
  }
  row(id) { return this.ctx.storage.sql.exec('SELECT * FROM connections WHERE id=?', id).toArray()[0]; }
  snapshot(owner) {
    return this.ctx.storage.transactionSync(() => {
      this.guard(owner);
      return { connections: this.ctx.storage.sql.exec('SELECT metadata FROM connections ORDER BY id').toArray().map(r => connectionMetadata(JSON.parse(r.metadata))), deploymentIntegration: false };
    });
  }
  async mutate(owner, raw) {
    const input = connectionInput(raw);
    this.ctx.storage.transactionSync(() => this.guard(owner));
    if (input.action === 'create') {
      const digest = await connectionDigest(input), existing = this.row(input.id);
      if (existing) {
        if (existing.digest !== digest) throw new Error('id conflict');
        return { connection: connectionMetadata(JSON.parse(existing.metadata)) };
      }
      if (this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM connections').one().n >= 32) throw new Error('capacity');
      const check = await verifyConnection(input, input.token);
      if (!check.ok) return { error: 'verification-failed' };
      const time = Date.now();
      const metadata = { id: input.id, name: input.name, provider: input.provider, target: input.target,
        revision: 1, state: 'verified', check: check.code, checkedAt: time, createdAt: time, updatedAt: time };
      const sealed = await sealToken(this.env.CONNECTIONS_ENCRYPTION_KEY, owner, metadata, input.token);
      return this.ctx.storage.transactionSync(() => {
        this.guard(owner); const race = this.row(input.id);
        if (race) { if (race.digest !== digest) throw new Error('id conflict'); return { connection: connectionMetadata(JSON.parse(race.metadata)) }; }
        if (this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM connections').one().n >= 32) throw new Error('capacity');
        this.ctx.storage.sql.exec('INSERT INTO connections(id,metadata,sealed,digest) VALUES(?,?,?,?)', input.id, JSON.stringify(metadata), sealed, digest);
        return { connection: connectionMetadata(metadata) };
      });
    }
    const stored = this.row(input.id); if (!stored) throw new Error('missing connection');
    const metadata = JSON.parse(stored.metadata);
    if (metadata.revision !== input.revision || metadata.state === 'disabled') throw new Error('stale connection');
    let check;
    if (input.action === 'verify') {
      try { check = await verifyConnection(metadata, await openToken(this.env.CONNECTIONS_ENCRYPTION_KEY, owner, metadata, stored.sealed)); }
      catch { check = { ok: false, code: 'credential-unavailable' }; }
    }
    return this.ctx.storage.transactionSync(() => {
      this.guard(owner); const current = JSON.parse(this.row(input.id).metadata);
      if (current.revision !== input.revision || current.state === 'disabled') throw new Error('stale connection');
      const next = { ...current, revision: current.revision + 1, updatedAt: Date.now(),
        ...(check ? { state: check.ok ? 'verified' : 'failed', check: check.code, checkedAt: Date.now() } : { state: 'disabled' }) };
      this.ctx.storage.sql.exec('UPDATE connections SET metadata=? WHERE id=?', JSON.stringify(next), input.id);
      return { connection: connectionMetadata(next) };
    });
  }
}
