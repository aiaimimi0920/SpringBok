import { DurableObject } from 'cloudflare:workers';
import { connectionInput, connectionMetadata, ownerId, validVaultKey } from './connections-contract.mjs';
import { connectionDigest, sealToken, openToken } from './connections-crypto.mjs';
import { verifyConnection } from './connections-provider.mjs';
import { resourceInput, discoverResources } from './resources.mjs';

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
  resourceGuard(owner) {
    this.guard(owner);
    const sql = this.ctx.storage.sql, tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('resource_meta','resource_lists','resources')").toArray();
    if (tables.length === 0) {
      sql.exec('CREATE TABLE resource_meta (version INTEGER PRIMARY KEY CHECK(version=1))'); sql.exec('INSERT INTO resource_meta VALUES(1)');
      sql.exec('CREATE TABLE resource_lists (connection TEXT NOT NULL, kind TEXT NOT NULL, listing TEXT NOT NULL, PRIMARY KEY(connection,kind))');
      sql.exec('CREATE TABLE resources (id TEXT PRIMARY KEY, connection TEXT NOT NULL, kind TEXT NOT NULL, remote_id TEXT NOT NULL, metadata TEXT NOT NULL, UNIQUE(connection,kind,remote_id))');
    } else if (tables.length !== 3 || sql.exec('SELECT version FROM resource_meta').toArray().length !== 1) throw new Error('resource storage damaged');
  }
  activeConnection(id, revision = null) {
    const stored = this.row(id); if (!stored) throw new Error('missing connection');
    const row = JSON.parse(stored.metadata);
    if (row.state !== 'verified' || (revision !== null && row.revision !== revision)) throw new Error('connection unavailable');
    return { row, sealed: stored.sealed };
  }
  resourceSnapshot(owner) {
    return this.ctx.storage.transactionSync(() => {
      this.resourceGuard(owner);
      return { resources: this.ctx.storage.sql.exec('SELECT metadata FROM resources ORDER BY id').toArray().map(({metadata}) => {
        const resource = JSON.parse(metadata), connection = JSON.parse(this.row(resource.connectionId).metadata);
        return { ...resource, available: connection.state === 'verified' && connection.revision === resource.connectionRevision };
      }) };
    });
  }
  async resourceOperation(owner, raw) {
    const input = resourceInput(raw); this.ctx.storage.transactionSync(() => this.resourceGuard(owner));
    const { row, sealed } = this.activeConnection(input.connectionId);
    if (row.provider !== 'cloudflare') throw new Error('Cloudflare required');
    if (input.action === 'discover') {
      const pending = JSON.stringify({ operation: crypto.randomUUID() });
      this.ctx.storage.sql.exec('INSERT INTO resource_lists VALUES(?,?,?) ON CONFLICT(connection,kind) DO UPDATE SET listing=excluded.listing',row.id,input.kind,pending);
      const result = await discoverResources(row.target, await openToken(this.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed), input.kind,input.cursor);
      return this.ctx.storage.transactionSync(() => {
        this.activeConnection(row.id,row.revision);
        if (this.ctx.storage.sql.exec('SELECT listing FROM resource_lists WHERE connection=? AND kind=?',row.id,input.kind).one().listing !== pending) throw new Error('superseded discovery');
        const listing = { id: crypto.randomUUID(), connectionId: row.id, connectionRevision: row.revision, accountId: row.target, kind: input.kind, checkedAt: Date.now(), ...result };
        this.ctx.storage.sql.exec('UPDATE resource_lists SET listing=? WHERE connection=? AND kind=?',JSON.stringify(listing),row.id,input.kind);
        return listing;
      });
    }
    return this.ctx.storage.transactionSync(() => {
      this.activeConnection(row.id,row.revision);
      const saved = this.ctx.storage.sql.exec('SELECT listing FROM resource_lists WHERE connection=? AND kind=?',row.id,input.kind).toArray()[0];
      const listing = saved && JSON.parse(saved.listing);
      if (!listing || listing.id !== input.listingId || listing.connectionRevision !== row.revision || Date.now() - listing.checkedAt > 300000) throw new Error('listing expired');
      const item = listing.items.find(r => r.id === input.resourceId); if (!item) throw new Error('resource not listed');
      const prior = this.ctx.storage.sql.exec('SELECT metadata FROM resources WHERE connection=? AND kind=? AND remote_id=?',row.id,input.kind,item.id).toArray()[0];
      if (!prior && this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM resources').one().n >= 128) throw new Error('resource capacity');
      const old = prior && JSON.parse(prior.metadata), resource = { id: old?.id ?? crypto.randomUUID(), revision: (old?.revision ?? 0) + 1,
        connectionId: row.id, connectionRevision: row.revision, accountId: row.target, kind: input.kind, remoteId: item.id, name: item.name, checkedAt: listing.checkedAt };
      if (old?.checkedAt === listing.checkedAt && old.connectionRevision === row.revision) return { resource: old };
      this.ctx.storage.sql.exec('INSERT INTO resources VALUES(?,?,?,?,?) ON CONFLICT(connection,kind,remote_id) DO UPDATE SET metadata=excluded.metadata',resource.id,row.id,input.kind,item.id,JSON.stringify(resource));
      return { resource };
    });
  }
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
