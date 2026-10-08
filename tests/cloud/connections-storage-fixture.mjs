import { ConnectionVault as Vault } from '../../cloud/connections-store.mjs';
export { default, TargetMailbox, OwnerCatalog, NodeMailbox, NodeTelemetry, SbaDeployment, ConnectedDeployment, DeploymentLocks } from '../../cloud/worker.mjs';
export class ConnectionVault extends Vault {
  inspectStorage() { return this.ctx.storage.sql.exec('SELECT * FROM connections').toArray(); }
  inspectBudgetTables() { return this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('usage_budget_meta','usage_budgets') ORDER BY name").toArray(); }
  expireListing() { this.ctx.storage.sql.exec("UPDATE resource_lists SET listing=json_set(listing,'$.checkedAt',0)"); }
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
