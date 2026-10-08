import { exactSba as exact, requireSba as requireValue, canonicalSba } from './sba-control.mjs';
import { connectionId } from './connections-contract.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const key = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !['__proto__','prototype','constructor'].includes(value);
const path = value => requireValue(Array.isArray(value) && value.length > 0 && value.length <= 6 && value.every(key));
function publicValue(value, depth=0) {
  requireValue(depth <= 8);
  if (Array.isArray(value)) { requireValue(value.length <= 100); value.forEach(v=>publicValue(v,depth+1)); }
  else if (object(value)) for(const [k,v] of Object.entries(value)) {
    requireValue(key(k) && (!/token|password|secret|credential|privatekey|apikey|accesskey|authorization|connectionstring/i.test(k.replaceAll('_','')) || (k === 'secretNames' && Array.isArray(v) && v.every(x=>typeof x==='string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(x)))));
    publicValue(v,depth+1);
  }
  else requireValue(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 8192 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)));
}
export function deploymentDeclaration(value) {
  const automatic=value?.schemaVersion===2;
  exact(value,['schemaVersion','target','accountPath','defaults','fields','resources','targets',...(automatic?['accountMode','accounts']:[])]);
  requireValue([1,2].includes(value.schemaVersion) && value.target==='cloudflare-workers' && object(value.defaults));publicValue(value.defaults);
  if(automatic){
    requireValue(['single','multiple'].includes(value.accountMode)&&Array.isArray(value.accounts)&&value.accounts.length>0&&value.accounts.length<=12);
    requireValue(value.accountMode!=='single'||value.accounts.length===1);
    for(const account of value.accounts){exact(account,['key','label','path','secret']);requireValue(key(account.key)&&/^[A-Z][A-Z0-9_]{1,63}$/.test(account.secret));label(account.label);path(account.path);}
    requireValue(value.accounts[0].key==='runtime'&&canonicalSba(value.accounts[0].path)===canonicalSba(value.accountPath));
    requireValue(new Set(value.accounts.map(a=>a.key)).size===value.accounts.length&&new Set(value.accounts.map(a=>a.secret)).size===value.accounts.length);
  }
  requireValue(Array.isArray(value.fields) && value.fields.length <= 32 && Array.isArray(value.resources) && value.resources.length <= 12);
  const paths=automatic?value.accounts.map(a=>a.path):[value.accountPath];
  const accountKey=k=>requireValue(value.accounts.some(a=>a.key===k));
  for(const field of value.fields){exact(field,['path','label','type','required',...(automatic?['template']:[])]);requireValue(['text','json'].includes(field.type)&&typeof field.required==='boolean');label(field.label);paths.push(field.path);if(automatic)requireValue(field.template===null||field.type==='text'&&validTemplate(field.template,value.accounts));}
  for(const resource of value.resources){exact(resource,['key','label','kind','idPath','namePath',...(automatic?['account','nativeAccount','nameTemplate']:[])]);requireValue(key(resource.key)&&['d1','kv','r2'].includes(resource.kind));label(resource.label);paths.push(resource.idPath);if(resource.namePath!==null)paths.push(resource.namePath);if(automatic){accountKey(resource.account);if(resource.nativeAccount!==null)accountKey(resource.nativeAccount);requireValue(validTemplate(resource.nameTemplate,value.accounts)&&resource.nameTemplate.includes('{instance}'));}}
  requireValue(new Set(value.resources.map(r=>r.key)).size===value.resources.length);
  requireValue(Array.isArray(value.targets)&&value.targets.length>0&&value.targets.length<=8);
  for(const target of value.targets){exact(target,['kind','path',...(automatic?['account']:[])]);path(target.path);requireValue(['worker','domain'].includes(target.kind)&&value.fields.some(f=>f.type==='text'&&f.required&&f.path.join('.')===target.path.join('.')));if(automatic)accountKey(target.account);}
  requireValue(new Set(value.targets.map(t=>t.path.join('.'))).size===value.targets.length);
  paths.forEach(path);const names=paths.map(p=>p.join('.'));
  requireValue(names.every((n,i)=>names.every((m,j)=>i===j || (n!==m&&!n.startsWith(m+'.')&&!m.startsWith(n+'.')))));
  requireValue(new TextEncoder().encode(canonicalSba(value)).length<=32768);return structuredClone(value);
}
function validTemplate(value,accounts){return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value)&&!value.replaceAll('{instance}','').replace(/\{subdomain:([A-Za-z][A-Za-z0-9_]*)\}/g,(all,key)=>accounts.some(a=>a.key===key)?'':all).match(/[{}]/);}
export const deploymentValue=(root,parts)=>parts.reduce((v,k)=>v?.[k],root);
export function deploymentSecrets(declaration){return declaration.schemaVersion===2?declaration.accounts.map(a=>a.secret):['CLOUDFLARE_API_TOKEN'];}
export function deploymentTemplate(template,environment,facts={}){return template.replaceAll('{instance}',environment).replace(/\{subdomain:([A-Za-z][A-Za-z0-9_]*)\}/g,(_,key)=>{const value=facts[key]?.subdomain;requireValue(typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value));return value;});}
function label(value){requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=100&&!/[\x00-\x1f]/.test(value));}
export function connectionReference(value) {exact(value,['id','revision']);connectionId(value.id);requireValue(Number.isSafeInteger(value.revision)&&value.revision>0);return value;}
export function deploymentInput(input) {
  const keys=input.action==='application'?['action','github','sourceSha']:['action','github','sourceSha','cloudflare','environment','values','resources'];
  if(Object.hasOwn(input,'repository'))keys.push('repository');
  if(input.action==='preview'&&Object.hasOwn(input,'accounts'))keys.push('accounts');
  if(input.action==='preview'&&Object.hasOwn(input,'instance')){keys.push('instance');exact(input.instance,['id','previousTaskId']);for(const value of Object.values(input.instance))requireValue(typeof value==='string'&&/^dc-[a-f0-9]{32}$/.test(value));}
  exact(input,keys);
  requireValue(['application','preview'].includes(input.action));connectionReference(input.github);requireValue(typeof input.sourceSha==='string'&&/^[a-f0-9]{40}$/.test(input.sourceSha));
  if(Object.hasOwn(input,'repository'))requireValue(typeof input.repository==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository));
  if(input.action==='preview'){connectionReference(input.cloudflare);requireValue(typeof input.environment==='string'&&/^[a-z][a-z0-9-]{1,62}$/.test(input.environment)&&object(input.values)&&object(input.resources));if(input.accounts){requireValue(object(input.accounts));Object.values(input.accounts).forEach(connectionReference);}}
  return input;
}
export function setDeploymentValue(root, parts, value){let current=root;for(const part of parts.slice(0,-1)){if(!Object.hasOwn(current,part))current[part]={};requireValue(object(current[part]));current=current[part];}current[parts.at(-1)]=value;}
const set=setDeploymentValue;
export function automaticConfiguration(declaration,values,resources,accounts,environment,facts={}){
  const d=deploymentDeclaration(declaration),configuration=structuredClone(d.defaults);requireValue(d.schemaVersion===2);
  requireValue(Object.keys(values).every(k=>d.fields.some(f=>f.path.join('.')===k)));exact(resources,d.resources.map(r=>r.key));exact(accounts,d.accounts.map(a=>a.key));
  for(const account of d.accounts){requireValue(/^[a-f0-9]{32}$/.test(accounts[account.key].accountId));set(configuration,account.path,accounts[account.key].accountId);}
  for(const field of d.fields){const name=field.path.join('.'),value=Object.hasOwn(values,name)?values[name]:field.template===null?deploymentValue(configuration,field.path):deploymentTemplate(field.template,environment,facts);if(field.type==='text')requireValue(typeof value==='string'&&(!field.required||!!value.trim()));else requireValue(value!==undefined&&(!field.required||value!==null));publicValue(value);set(configuration,field.path,value);}
  for(const field of d.resources){const row=resources[field.key];requireValue(row.kind===field.kind&&row.accountId===accounts[field.account].accountId);if(field.nativeAccount!==null)requireValue(row.accountId===accounts[field.nativeAccount].accountId);set(configuration,field.idPath,row.remoteId);if(field.namePath)set(configuration,field.namePath,row.name);}
  publicValue(configuration);deploymentTargets(d,configuration);requireValue(new TextEncoder().encode(canonicalSba(configuration)).length<=32768);return configuration;
}
export function deploymentConfiguration(declaration, values, resources, accountId) {
  const d=deploymentDeclaration(declaration), configuration=structuredClone(d.defaults);
  requireValue(/^[a-f0-9]{32}$/.test(accountId));exact(values,d.fields.map(f=>f.path.join('.')));exact(resources,d.resources.map(r=>r.key));
  set(configuration,d.accountPath,accountId);
  for(const field of d.fields){const value=values[field.path.join('.')];if(field.type==='text')requireValue(typeof value==='string'&&(!field.required||!!value.trim()));else requireValue(!field.required||value!==null);publicValue(value);set(configuration,field.path,value);}
  for(const field of d.resources){const row=resources[field.key];requireValue(row&&row.kind===field.kind&&row.accountId===accountId);set(configuration,field.idPath,row.remoteId);if(field.namePath)set(configuration,field.namePath,row.name);}
  publicValue(configuration);deploymentTargets(d,configuration);requireValue(new TextEncoder().encode(canonicalSba(configuration)).length<=32768);return configuration;
}
export function deploymentTargets(declaration,configuration){return declaration.targets.map(target=>{let value=configuration;for(const part of target.path)value=value?.[part];requireValue(typeof value==='string');if(target.kind==='worker')requireValue(/^[a-z][a-z0-9-]{1,62}$/.test(value));else{const url=new URL(value);requireValue(url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password&&!url.port&&(declaration.schemaVersion===2||!url.hostname.endsWith('.workers.dev')));}return {kind:target.kind,value,...(declaration.schemaVersion===2?{accountId:deploymentValue(configuration,declaration.accounts.find(a=>a.key===target.account).path)}:{})};});}
