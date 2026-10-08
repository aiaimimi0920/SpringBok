import { connectionId } from './connections-contract.mjs';
import { openToken } from './connections-crypto.mjs';
import { readResourceUsage } from './resource-usage.mjs';

const check = value => { if (!value) throw new Error('resource budget rejected'); };
const exact = (value, keys) => check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys.sort().join());
function storage(vault, create = false) {
  const sql = vault.ctx.storage.sql;
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage_budget_meta','usage_budgets')").toArray();
  if (!tables.length && !create) return null;
  if (!tables.length) {
    sql.exec('CREATE TABLE usage_budget_meta (version INTEGER PRIMARY KEY CHECK(version=1))');
    sql.exec('INSERT INTO usage_budget_meta VALUES(1)');
    sql.exec('CREATE TABLE usage_budgets (account TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, value REAL, PRIMARY KEY(account,kind))');
  } else {
    check(tables.length === 2);
    const versions = sql.exec('SELECT version FROM usage_budget_meta').toArray();
    check(versions.length === 1 && versions[0].version === 1);
  }
  return sql;
}
function budget(vault, account, kind) {
  const sql = storage(vault);
  const row = sql?.exec('SELECT revision,value FROM usage_budgets WHERE account=? AND kind=?', account, kind).toArray()[0];
  return row ?? { revision: 0, value: null };
}
export async function usageOperation(vault, owner, input) {
  exact(input, ['action', 'connectionId', 'kind']); check(input.action === 'usage'); connectionId(input.connectionId);
  check(['d1', 'kv', 'r2', 'worker'].includes(input.kind));
  vault.ctx.storage.transactionSync(() => vault.guard(owner));
  const { row, sealed } = vault.activeConnection(input.connectionId); check(row.provider === 'cloudflare');
  const token = await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY, owner, row, sealed);
  const result = await readResourceUsage(row.target, token, input.kind);
  return vault.ctx.storage.transactionSync(() => {
    vault.activeConnection(row.id, row.revision);
    return { ...result, connectionId: row.id, connectionRevision: row.revision, kind: input.kind, budget: budget(vault, row.target, input.kind) };
  });
}
export function saveResourceBudget(vault, owner, input) {
  exact(input, ['action', 'connectionId', 'connectionRevision', 'kind', 'revision', 'value']);
  check(input.action === 'budget'); connectionId(input.connectionId);
  check(['d1', 'kv', 'r2'].includes(input.kind) && Number.isSafeInteger(input.connectionRevision) && input.connectionRevision > 0);
  check(Number.isSafeInteger(input.revision) && input.revision >= 0 && (input.value === null || Number.isSafeInteger(input.value) && input.value >= 0 && input.value <= 1e15));
  return vault.ctx.storage.transactionSync(() => {
    vault.guard(owner); const { row } = vault.activeConnection(input.connectionId, input.connectionRevision); check(row.provider === 'cloudflare');
    const old = budget(vault, row.target, input.kind); check(old.revision === input.revision);
    const sql = storage(vault, true), next = { revision: old.revision + 1, value: input.value };
    sql.exec('INSERT INTO usage_budgets VALUES(?,?,?,?) ON CONFLICT(account,kind) DO UPDATE SET revision=excluded.revision,value=excluded.value', row.target, input.kind, next.revision, next.value);
    return { budget: next };
  });
}
