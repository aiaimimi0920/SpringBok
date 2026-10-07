import { ConnectionVault as Vault } from '../../cloud/connections-store.mjs';
export { default, TargetMailbox, OwnerCatalog, NodeMailbox, NodeTelemetry, SbaDeployment } from '../../cloud/worker.mjs';
export class ConnectionVault extends Vault {
  inspectStorage() { return this.ctx.storage.sql.exec('SELECT * FROM connections').toArray(); }
  breakStorage(kind) {
    if (kind === 'owner') this.ctx.storage.sql.exec('DELETE FROM connection_owner');
    else if (kind === 'table') this.ctx.storage.sql.exec('DROP TABLE connections');
    else throw new Error('unsupported fixture');
  }
}
