import { exactSba, requireSba } from './sba-control.mjs';

const at = (root, path) => path.reduce((value, key) => value?.[key], root);
export const emailDomain = value => typeof value === 'string' && value.length <= 253 && value.includes('.') && value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
export const emailIdentity = zoneId => 'email-routing:' + zoneId;
export function validateEmailTarget(target, declaration, validatePath) {
  requireSba(declaration.schemaVersion === 2);
  validatePath(target.workerPath);
  const field = declaration.fields.find(row => row.path.join('.') === target.path.join('.'));
  requireSba(field?.type === 'json' && field.required === false && field.template === null && at(declaration.defaults, target.path) === null);
  requireSba(declaration.targets.some(row => row.kind === 'worker' && row.account === target.account && row.path.join('.') === target.workerPath.join('.')));
}
export function emailTarget(target, declaration, configuration) {
  const value = at(configuration, target.path);
  if (value === null) return [];
  exactSba(value, ['zoneId', 'domain']);
  requireSba(/^[a-f0-9]{32}$/.test(value.zoneId) && emailDomain(value.domain));
  const worker = at(configuration, target.workerPath);
  requireSba(typeof worker === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(worker));
  const accountId = at(configuration, declaration.accounts.find(row => row.key === target.account).path);
  return [{ kind: 'email-routing', value: emailIdentity(value.zoneId), accountId, ...value, worker }];
}
