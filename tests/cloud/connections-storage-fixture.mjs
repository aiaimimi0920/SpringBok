import { ConnectionVault as Vault } from '../../cloud/connections-store.mjs';
import { ConnectedDeployment as ConnectedStore } from '../../cloud/connected-store.mjs';
export { default, TargetMailbox, OwnerCatalog, NodeMailbox, NodeTelemetry, SbaDeployment, DeploymentLocks } from '../../cloud/worker.mjs';
export class ConnectedDeployment extends ConnectedStore {
  seedOrphanSba() { this.ctx.storage.sql.exec('CREATE TABLE sba_orphan (id INTEGER PRIMARY KEY)'); }
  async raceInitialization(owner, taskId, plan, record) {
    const pending = this.initialize(owner, taskId, plan);
    this.cancelUninitialized(owner, record);
    try { await pending; return { rejected: false }; }
    catch { return { rejected: true, cancellation: this.cancellation(owner, taskId) }; }
  }
}
export class ConnectionVault extends Vault {
  patchPreparation(taskId, patch) {
    const sql=this.ctx.storage.sql,record=JSON.parse(sql.exec('SELECT record FROM connection_deployments WHERE task=?',taskId).one().record);
    Object.assign(record.preparation,patch);sql.exec('UPDATE connection_deployments SET record=? WHERE task=?',JSON.stringify(record),taskId);
  }
  inspectStorage() { return this.ctx.storage.sql.exec('SELECT * FROM connections').toArray(); }
  inspectApplicationSecrets() { return { profiles:this.ctx.storage.sql.exec('SELECT * FROM application_secrets').toArray(),tasks:this.ctx.storage.sql.exec('SELECT * FROM application_task_secrets').toArray() }; }
  corruptApplicationTaskSecret(task,name) {
    const sql=this.ctx.storage.sql,row=sql.exec('SELECT sealed FROM application_task_secrets WHERE task=? AND name=?',task,name).one(),sealed=JSON.parse(row.sealed);
    sealed.cipher=(sealed.cipher[0]==='0'?'1':'0')+sealed.cipher.slice(1);
    sql.exec('UPDATE application_task_secrets SET sealed=? WHERE task=? AND name=?',JSON.stringify(sealed),task,name);
  }
  fillResourceCapacity(count) {
    const sql=this.ctx.storage.sql,row=JSON.parse(sql.exec('SELECT metadata FROM resources LIMIT 1').one().metadata);
    while(sql.exec('SELECT COUNT(*) AS n FROM resources').one().n<count){const id=crypto.randomUUID(),copy={...row,id,remoteId:id};sql.exec('INSERT INTO resources VALUES(?,?,?,?,?)',id,row.connectionId,row.kind,id,JSON.stringify(copy));}
  }
  inspectBudgetTables() { return this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('usage_budget_meta','usage_budgets') ORDER BY name").toArray(); }
  expireListing() { this.ctx.storage.sql.exec("UPDATE resource_lists SET listing=json_set(listing,'$.checkedAt',0)"); }
  expireAdminOverrides() { this.ctx.storage.sql.exec("UPDATE admin_profiles SET metadata=json_set(metadata,'$.expiresAt',1) WHERE json_extract(metadata,'$.kind')='override'"); }
  adminProfileCount() { return this.ctx.storage.sql.exec('SELECT count(*) AS n FROM admin_profiles').one().n; }
  legacyDeploymentIndex() { this.ctx.storage.sql.exec("UPDATE connection_deployments SET record=json_remove(record,'$.service')"); }
  breakStorage(kind) {
    if (kind === 'owner') this.ctx.storage.sql.exec('DELETE FROM connection_owner');
    else if (kind === 'table') this.ctx.storage.sql.exec('DROP TABLE connections');
    else if (kind === 'resources') this.ctx.storage.sql.exec('DROP TABLE resources');
    else if (kind === 'budgets') this.ctx.storage.sql.exec('DROP TABLE usage_budgets');
    else if (kind === 'budget-version') {
      this.ctx.storage.sql.exec('DROP TABLE usage_budget_meta');
      this.ctx.storage.sql.exec('CREATE TABLE usage_budget_meta (version INTEGER PRIMARY KEY)');
      this.ctx.storage.sql.exec('INSERT INTO usage_budget_meta VALUES(2)');
    }
    else throw new Error('unsupported fixture');
  }
}
