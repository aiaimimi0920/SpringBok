import { ConnectionVault as Vault } from '../../cloud/connections-store.mjs';
export { default, TargetMailbox, OwnerCatalog, NodeMailbox, NodeTelemetry, SbaDeployment } from '../../cloud/worker.mjs';
export class ConnectionVault extends Vault {
  inspectStorage() { return this.ctx.storage.sql.exec('SELECT * FROM connections').toArray(); }
  expireListing() { this.ctx.storage.sql.exec("UPDATE resource_lists SET listing=json_set(listing,'$.checkedAt',0)"); }
  breakStorage(kind) {
    if (kind === 'owner') this.ctx.storage.sql.exec('DELETE FROM connection_owner');
    else if (kind === 'table') this.ctx.storage.sql.exec('DROP TABLE connections');
    else if (kind === 'resources') this.ctx.storage.sql.exec('DROP TABLE resources');
    else throw new Error('unsupported fixture');
  }
}
