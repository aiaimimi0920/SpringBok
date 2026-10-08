import { DurableObject } from 'cloudflare:workers';
import { connectionInput, connectionMetadata, ownerId, validVaultKey } from './connections-contract.mjs';
import { connectionDigest, sealToken, openToken } from './connections-crypto.mjs';
import { verifyConnection } from './connections-provider.mjs';
import { resourceInput, discoverResources } from './resources.mjs';
import { deploymentInput, deploymentDeclaration, deploymentConfiguration, connectionReference } from './deployment-contract.mjs';
import { sbaPolicy, connectedSbaPolicy, sbaDigest, requireSba } from './sba-control.mjs';
import { applicationRepository, readApplication, serviceCatalog } from './service-catalog.mjs';
import { serviceSummary, serviceEntries, updateOperation } from './service-instance.mjs';
import { connectedTaskId } from './connected-store.mjs';
import { connectBrand, inventory, useRepository } from './brand-resources.mjs';
import { usageOperation, saveResourceBudget } from './resource-budgets.mjs';
import { importInput, importedId, inspectImported, sameImport } from './service-import.mjs';
import { automaticDraft, provisionDeployment } from './deployment-provisioning.mjs';
import { servicePreviewDraft, continuesInstance, createsResources } from './service-preview.mjs';

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
    if (row.parentId) this.activeConnection(row.parentId,row.parentRevision);
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
    if(raw?.action === 'inventory') return inventory(this,owner,raw);
    if(raw?.action === 'usage') return usageOperation(this,owner,raw);
    if(raw?.action === 'budget') return saveResourceBudget(this,owner,raw);
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
      if (!prior && this.resourceCapacity() >= 128) throw new Error('resource capacity');
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
      return { connections: this.ctx.storage.sql.exec('SELECT metadata FROM connections ORDER BY id').toArray().map(r => {
        const row=JSON.parse(r.metadata), metadata=connectionMetadata(row);
        if(row.parentId){try{this.activeConnection(row.id,row.revision);metadata.deploymentAvailable=true;}catch{metadata.deploymentAvailable=false;}}
        return metadata;
      }), deploymentIntegration: false };
    });
  }
  // 仅供 Worker 内部受认证路径调用；不在任何 HTTP 响应中返回凭据。
  serviceCatalog(owner, kind, input) { return serviceCatalog(this, owner, kind, input); }
  async importDraft(owner, raw) {
    const input = importInput(raw); this.ctx.storage.transactionSync(() => this.guard(owner));
    const github = this.activeConnection(input.github.id, input.github.revision), cloudflare = this.activeConnection(input.cloudflare.id, input.cloudflare.revision);
    requireSba(github.row.provider === 'github' && cloudflare.row.provider === 'cloudflare');
    const application = await readApplication(this.env, applicationRepository(github.row, input.repository), input.sourceSha,
      await openToken(this.env.CONNECTIONS_ENCRYPTION_KEY, owner, github.row, github.sealed));
    const candidate = await inspectImported(owner, application, cloudflare.row.target,
      await openToken(this.env.CONNECTIONS_ENCRYPTION_KEY, owner, cloudflare.row, cloudflare.sealed), input.components,
      { github: input.github, cloudflare: input.cloudflare });
    this.activeConnection(github.row.id, github.row.revision); this.activeConnection(cloudflare.row.id, cloudflare.row.revision);
    return candidate;
  }
  importGuard(owner) {
    this.guard(owner); const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('service_import_meta','service_imports')").toArray();
    if (!tables.length) { sql.exec('CREATE TABLE service_import_meta (version INTEGER PRIMARY KEY CHECK(version=1))'); sql.exec('INSERT INTO service_import_meta VALUES(1)'); sql.exec('CREATE TABLE service_imports (id TEXT PRIMARY KEY, record TEXT NOT NULL)'); }
    else { const versions = sql.exec('SELECT version FROM service_import_meta').toArray(); requireSba(tables.length === 2 && versions.length === 1 && versions[0].version === 1); }
  }
  importedIndex(owner) { return this.ctx.storage.transactionSync(() => { this.importGuard(owner); return this.ctx.storage.sql.exec('SELECT record FROM service_imports ORDER BY rowid DESC').toArray().map(row => JSON.parse(row.record)); }); }
  saveImported(owner, candidate) {
    requireSba(importedId(candidate.id) && candidate.instance.id === candidate.id);
    return this.ctx.storage.transactionSync(() => {
      this.importGuard(owner); const sql = this.ctx.storage.sql, saved = sql.exec('SELECT record FROM service_imports WHERE id=?', candidate.id).toArray()[0];
      if (saved) { const prior = JSON.parse(saved.record); requireSba(sameImport(prior.candidate, candidate) && prior.candidate.instance.application.id === candidate.instance.application.id && prior.candidate.instance.application.repository === candidate.instance.application.repository); return prior; }
      if (candidate.instance.connections) for (const ref of Object.values(candidate.instance.connections)) this.activeConnection(ref.id, ref.revision);
      requireSba(sql.exec('SELECT COUNT(*) AS n FROM service_imports').one().n < 128);
      const record = { id: candidate.id, candidate, createdAt: Date.now() };
      sql.exec('INSERT INTO service_imports VALUES(?,?)', record.id, JSON.stringify(record)); return record;
    });
  }
  async deploymentDraft(owner, raw) {
    if (['rehearse', 'destroy-preview'].includes(raw?.action)) {
      this.ctx.storage.transactionSync(() => this.resourceGuard(owner));
      return servicePreviewDraft(this, owner, raw);
    }
    const input=deploymentInput(raw);this.ctx.storage.transactionSync(()=>this.resourceGuard(owner));
    const {row:github,sealed}=this.activeConnection(input.github.id,input.github.revision);requireSba(github.provider==='github');
    const base=connectedSbaPolicy(this.env), repository=applicationRepository(github,input.repository);
    const application=await readApplication(this.env,repository,input.sourceSha,await openToken(this.env.CONNECTIONS_ENCRYPTION_KEY,owner,github,sealed));
    const {manifest,declaration}=application;
    this.activeConnection(github.id,github.revision);
    if(input.action==='application')return application;
    const {row:cloudflare}=this.activeConnection(input.cloudflare.id,input.cloudflare.revision);requireSba(cloudflare.provider==='cloudflare');
    let resources={},automatic=null;
    if(declaration.schemaVersion===2){automatic=await automaticDraft(this,owner,input,application);resources=automatic.resources;}
    else {requireSba(!Object.hasOwn(input,'accounts'));
    for(const field of declaration.resources){const ref=connectionReference(input.resources[field.key]);const stored=this.ctx.storage.sql.exec('SELECT metadata FROM resources WHERE id=?',ref.id).toArray()[0];requireSba(stored);const row=JSON.parse(stored.metadata);
      requireSba(row.revision===ref.revision&&row.connectionId===cloudflare.id&&row.connectionRevision===cloudflare.revision&&Date.now()-row.checkedAt<=300000);resources[field.key]=row;}
    requireSba(Object.keys(input.resources).length===declaration.resources.length);}
    const configuration=automatic?.configuration??deploymentConfiguration(declaration,input.values,resources,cloudflare.target);
    const policy={...base,github:{...base.github,applicationRepository:repository},sourceSha:input.sourceSha,environment:input.environment,configuration,secretNames:manifest.secrets};
    sbaPolicy({...this.env,SBA_POLICY:JSON.stringify(policy)});
    const plan={application,policy,connections:{github:input.github,cloudflare:input.cloudflare},resources,configuration,...(automatic??{})};
    if(input.instance)plan.operation=await updateOperation(this,owner,input.instance,plan);
    return {...plan,digest:await sbaDigest({application,policy,connections:plan.connections,resources,...(automatic?{accounts:plan.accounts,credentials:plan.credentials}:{}),...(plan.operation?{operation:plan.operation}:{})})};
  }
  deploymentGuard(owner){
    this.resourceGuard(owner);const sql=this.ctx.storage.sql,tables=sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('connection_deployment_meta','connection_deployments')").toArray();
    if(!tables.length){sql.exec('CREATE TABLE connection_deployment_meta (version INTEGER PRIMARY KEY CHECK(version=1))');sql.exec('INSERT INTO connection_deployment_meta VALUES(1)');sql.exec('CREATE TABLE connection_deployments (task TEXT PRIMARY KEY,record TEXT NOT NULL)');}
    else requireSba(tables.length===2&&sql.exec('SELECT version FROM connection_deployment_meta').toArray().length===1);
  }
  resourceCapacity(){
    const sql=this.ctx.storage.sql;
    const records=sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='connection_deployments'").toArray().length?sql.exec('SELECT record FROM connection_deployments').toArray():[];
    const reserved=records.reduce((count,row)=>{const preparation=JSON.parse(row.record).preparation;return count+(preparation&&preparation.phase!=='ready'?Object.keys(preparation.intent.resources).length:0);},0);
    return sql.exec('SELECT COUNT(*) AS n FROM resources').one().n+reserved;
  }
  reserveDeployment(owner,taskId,plan){
    connectedTaskId(taskId);return this.ctx.storage.transactionSync(()=>{
      this.deploymentGuard(owner);const sql=this.ctx.storage.sql,prior=sql.exec('SELECT record FROM connection_deployments WHERE task=?',taskId).toArray()[0];
      const record={taskId,digest:plan.digest,connections:plan.connections,accountId:null,createdAt:Date.now(),service:serviceSummary(taskId,plan)};
      // 声明路径可能嵌套；账号身份以已核验的 Cloudflare 连接为准。
      const cloudflare=this.row(plan.connections.cloudflare.id);requireSba(cloudflare);record.accountId=JSON.parse(cloudflare.metadata).target;
      if(prior){const old=JSON.parse(prior.record);requireSba(old.digest===record.digest);return {...old,alreadyReserved:true};}
      if(plan.operation){const source=plan.operation.action==='preview'?plan.operation.context.source:{instanceId:plan.operation.instanceId,taskId:plan.operation.previousTaskId};const entries=serviceEntries(sql.exec('SELECT record FROM connection_deployments ORDER BY rowid DESC').toArray().map(r=>JSON.parse(r.record)),source.instanceId);requireSba(entries.length&&entries[0].taskId===source.taskId);}
      for(const ref of Object.values(plan.connections))this.activeConnection(ref.id,ref.revision);
      for(const row of Object.values(plan.resources)){if(plan.accounts&&row.provision)continue;const current=sql.exec('SELECT metadata FROM resources WHERE id=?',row.id).toArray()[0];requireSba(current&&JSON.parse(current.metadata).revision===row.revision&&(continuesInstance(plan)||Date.now()-row.checkedAt<=300000));}
      if(plan.accounts){record.accountIds=[...new Set(Object.values(plan.accounts).map(a=>a.accountId))].sort();record.credentials=plan.credentials;}
      if(createsResources(plan)){requireSba(this.resourceCapacity()+Object.keys(plan.resources).length<=128);record.preparation={phase:'reserved',intent:plan,resources:{}};}
      requireSba(sql.exec('SELECT COUNT(*) AS n FROM connection_deployments').one().n<128);sql.exec('INSERT INTO connection_deployments VALUES(?,?)',taskId,JSON.stringify(record));return record;
    });
  }
  deploymentIndex(owner){return this.ctx.storage.transactionSync(()=>{this.deploymentGuard(owner);return this.ctx.storage.sql.exec('SELECT record FROM connection_deployments ORDER BY rowid DESC').toArray().map(r=>JSON.parse(r.record));});}
  provisionDeployment(owner,taskId,plan){return provisionDeployment(this,owner,taskId,plan);}
  async deploymentCredential(owner,taskId,provider){
    this.ctx.storage.transactionSync(()=>this.deploymentGuard(owner));connectedTaskId(taskId);
    const saved=this.ctx.storage.sql.exec('SELECT record FROM connection_deployments WHERE task=?',taskId).toArray()[0];requireSba(saved);const record=JSON.parse(saved.record),stored=this.row(record.connections[provider].id);requireSba(stored);
    requireSba(provider==='github'||provider==='cloudflare'||Object.values(record.credentials??{}).includes(provider));
    const row=JSON.parse(stored.metadata);requireSba(row.provider===(provider==='github'?'github':'cloudflare'));return openToken(this.env.CONNECTIONS_ENCRYPTION_KEY,owner,row,stored.sealed);
  }
  async mutate(owner, raw) {
    if (raw?.action === 'connect') return connectBrand(this,owner,raw);
    if (raw?.action === 'use-repository') return useRepository(this,owner,raw);
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
