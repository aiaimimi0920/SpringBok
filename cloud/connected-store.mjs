import { DurableObject } from 'cloudflare:workers';
import { SbaDeployment } from './sba-store.mjs';
import { ownerId } from './connections-contract.mjs';
import { sbaPolicy, sbaRequest, sbaDigest, canonicalSba, requireSba, exactSba } from './sba-control.mjs';
import { importedId } from './service-import.mjs';
export const connectedTaskId = value => { requireSba(typeof value==='string'&&/^dc-[a-f0-9]{32}$/.test(value));return value; };
export const connectedStub = (env,taskId) => env.CONNECTED_TASKS.get(env.CONNECTED_TASKS.idFromName(`connected/v1/${connectedTaskId(taskId)}`));
export const accountStub = (env,accountId) => {requireSba(/^[a-f0-9]{32}$/.test(accountId));return env.DEPLOYMENT_LOCKS.get(env.DEPLOYMENT_LOCKS.idFromName(`deployment-account/v1/${accountId}`));};
export class ConnectedDeployment extends SbaDeployment {
  async initialize(owner,taskId,plan){
    ownerId(owner);connectedTaskId(taskId);requireSba(this.env.ENABLE_CONNECTED_DEPLOYMENTS==='yes');
    requireSba(this.ctx.id.toString()===this.env.CONNECTED_TASKS.idFromName(`connected/v1/${taskId}`).toString());
    const current=sbaPolicy(this.env),policy=sbaPolicy({...this.env,SBA_POLICY:JSON.stringify(plan.policy)});
    requireSba(canonicalSba({...policy.github,applicationRepository:current.github.applicationRepository})===canonicalSba(current.github)&&policy.runnerOrigin===current.runnerOrigin);
    const record={owner,taskId,plan},digest=await sbaDigest(record);
    return this.ctx.storage.transactionSync(()=>{
      const exists=this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='connected_bootstrap'").toArray();
      if(!exists.length){
        requireSba(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sba_%'").toArray().length===0);
        this.ctx.storage.sql.exec('CREATE TABLE connected_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL,digest TEXT NOT NULL)');
        this.ctx.storage.sql.exec('INSERT INTO connected_bootstrap VALUES(1,?,?)',JSON.stringify(record),digest);
      }else{const rows=this.ctx.storage.sql.exec('SELECT * FROM connected_bootstrap').toArray();requireSba(rows.length===1&&rows[0].digest===digest&&canonicalSba(JSON.parse(rows[0].record))===canonicalSba(record));}
      return {initialized:true};
    });
  }
  async bootstrap(actor=null){
    const rows=this.ctx.storage.sql.exec('SELECT * FROM connected_bootstrap').toArray();requireSba(rows.length===1&&rows[0].id===1);
    const record=JSON.parse(rows[0].record);exactSba(record,['owner','taskId','plan']);ownerId(record.owner);connectedTaskId(record.taskId);
    requireSba((actor===null||actor===record.owner)&&await sbaDigest(record)===rows[0].digest&&this.ctx.id.toString()===this.env.CONNECTED_TASKS.idFromName(`connected/v1/${record.taskId}`).toString());return record;
  }
  async policyFor(actor){const record=await this.bootstrap(actor);return sbaPolicy({...this.env,SBA_POLICY:JSON.stringify(record.plan.policy)});}
  async requestFor(policy,taskId,manifest){const record=await this.bootstrap();requireSba(record.taskId===taskId);return sbaRequest(policy,taskId,manifest,record.plan.operation??null);}
  async begin(actor,input){const record=await this.bootstrap(actor);requireSba(input.request.taskId===record.taskId);return super.begin(actor,input);}
  recoverUnstarted(){throw new Error('connected recovery not authorized');}
  recoverAuthorized(){throw new Error('connected recovery not authorized');}
}
export class DeploymentLocks extends DurableObject {
  registerImported(owner, id, accountId, resourceKeys, application) {
    ownerId(owner); requireSba(importedId(id) && Array.isArray(resourceKeys) && resourceKeys.length > 0 && resourceKeys.length <= 64);
    requireSba(this.ctx.id.toString() === this.env.DEPLOYMENT_LOCKS.idFromName(`deployment-account/v1/${accountId}`).toString());
    const keys = [...new Set(resourceKeys)].sort(); requireSba(keys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 256));
    const identity = canonicalSba({ owner, id, keys, application });
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql, tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('import_claims','import_keys')").toArray();
      if (!tables.length) { sql.exec('CREATE TABLE import_claims (id TEXT PRIMARY KEY, identity TEXT NOT NULL)'); sql.exec('CREATE TABLE import_keys (key TEXT PRIMARY KEY, instance TEXT NOT NULL)'); }
      else requireSba(tables.length === 2);
      const prior = sql.exec('SELECT identity FROM import_claims WHERE id=?', id).toArray()[0];
      if (prior) { requireSba(prior.identity === identity); return { registered: true }; }
      requireSba(sql.exec('SELECT COUNT(*) AS n FROM import_claims').one().n < 128);
      // Mirror claims into the old key table: a rolled-back controller must also
      // reject deployments onto imported resources, without owning the task lane.
      const deployed = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('deployment_claims','deployment_keys','deployment_lane')").toArray().length;
      requireSba(deployed === 0 || deployed === 3);
      if (!deployed) { sql.exec('CREATE TABLE deployment_claims (task TEXT PRIMARY KEY,identity TEXT NOT NULL)'); sql.exec('CREATE TABLE deployment_keys (key TEXT PRIMARY KEY,task TEXT NOT NULL)'); sql.exec('CREATE TABLE deployment_lane (id INTEGER PRIMARY KEY CHECK(id=1),task TEXT)'); sql.exec('INSERT INTO deployment_lane VALUES(1,NULL)'); }
      for (const key of keys) {
        requireSba(!sql.exec('SELECT task FROM deployment_keys WHERE key=?', 'identity:' + key).toArray().length);
        sql.exec('INSERT INTO import_keys VALUES(?,?)', 'identity:' + key, id);
        sql.exec('INSERT INTO deployment_keys VALUES(?,?)', 'identity:' + key, id);
      }
      sql.exec('INSERT INTO import_claims VALUES(?,?)', id, identity); return { registered: true };
    });
  }
  claim(owner,taskId,accountId,scope,resourceKeys,digest,observed=[],update=null){
    ownerId(owner);connectedTaskId(taskId);requireSba(/^[a-f0-9]{64}$/.test(digest)&&typeof scope==='string'&&scope.length<=300&&Array.isArray(resourceKeys)&&resourceKeys.length<=32&&Array.isArray(observed)&&observed.length<=256);
    requireSba(this.ctx.id.toString()===this.env.DEPLOYMENT_LOCKS.idFromName(`deployment-account/v1/${accountId}`).toString());
    if(update){exactSba(update,['instanceId','previousTaskId']);connectedTaskId(update.instanceId);connectedTaskId(update.previousTaskId);requireSba(taskId!==update.previousTaskId&&taskId!==update.instanceId);}
    const keys=[...new Set(resourceKeys)].sort(),identity=canonicalSba({owner,taskId,scope,resourceKeys:keys,digest,...(update??{})});
    return this.ctx.storage.transactionSync(()=>{
      const sql=this.ctx.storage.sql,tables=sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('deployment_claims','deployment_keys','deployment_lane')").toArray();
      if(!tables.length){sql.exec('CREATE TABLE deployment_claims (task TEXT PRIMARY KEY,identity TEXT NOT NULL)');sql.exec('CREATE TABLE deployment_keys (key TEXT PRIMARY KEY,task TEXT NOT NULL)');sql.exec('CREATE TABLE deployment_lane (id INTEGER PRIMARY KEY CHECK(id=1),task TEXT)');sql.exec('INSERT INTO deployment_lane VALUES(1,NULL)');}
      requireSba(tables.length===0||tables.length===3);const lane=sql.exec('SELECT * FROM deployment_lane').toArray();requireSba(lane.length===1&&lane[0].id===1);
      const prior=sql.exec('SELECT identity FROM deployment_claims WHERE task=?',taskId).toArray()[0];if(prior){requireSba(prior.identity===identity);return {claimed:true};}
      if (sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='import_keys'").toArray().length) {
        for (const key of [...keys, ...observed.map(value => 'identity:' + value)]) requireSba(!sql.exec('SELECT instance FROM import_keys WHERE key=?', key).toArray().length);
      }
      requireSba(lane[0].task===null&&sql.exec('SELECT COUNT(*) AS n FROM deployment_claims').one().n<128);
      if(update){
        const claims=sql.exec('SELECT identity FROM deployment_claims ORDER BY rowid').toArray().map(r=>JSON.parse(r.identity));
        const chain=claims.filter(r=>(r.instanceId??r.taskId)===update.instanceId),head=chain.at(-1),root=chain[0];
        requireSba(root?.taskId===update.instanceId&&head?.taskId===update.previousTaskId&&root.owner===owner&&head.owner===owner&&root.scope===scope&&head.scope===scope&&canonicalSba(root.resourceKeys)===canonicalSba(keys)&&canonicalSba(head.resourceKeys)===canonicalSba(keys));
      }
      for(const value of observed){requireSba(typeof value==='string'&&value.length<=256);const held=sql.exec('SELECT task FROM deployment_keys WHERE key=?','identity:'+value).toArray()[0];requireSba(!held||update&&held.task===update.instanceId);}
      for(const key of ['environment:'+scope,...keys]){requireSba(typeof key==='string'&&key.length<=350);if(update)requireSba(sql.exec('SELECT task FROM deployment_keys WHERE key=?',key).toArray()[0]?.task===update.instanceId);else sql.exec('INSERT INTO deployment_keys VALUES(?,?)',key,taskId);}
      sql.exec('INSERT INTO deployment_claims VALUES(?,?)',taskId,identity);sql.exec('UPDATE deployment_lane SET task=? WHERE id=1',taskId);return {claimed:true};
    });
  }
  release(taskId){connectedTaskId(taskId);this.ctx.storage.sql.exec('UPDATE deployment_lane SET task=NULL WHERE id=1 AND task=?',taskId);}
}
