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
  exact(value,['schemaVersion','target','accountPath','defaults','fields','resources','targets']);
  requireValue(value.schemaVersion===1 && value.target==='cloudflare-workers' && object(value.defaults));publicValue(value.defaults);
  requireValue(Array.isArray(value.fields) && value.fields.length <= 32 && Array.isArray(value.resources) && value.resources.length <= 12);
  const paths=[value.accountPath];
  for(const field of value.fields){exact(field,['path','label','type','required']);requireValue(['text','json'].includes(field.type)&&typeof field.required==='boolean');label(field.label);paths.push(field.path);}
  for(const resource of value.resources){exact(resource,['key','label','kind','idPath','namePath']);requireValue(key(resource.key)&&['d1','kv','r2'].includes(resource.kind));label(resource.label);paths.push(resource.idPath);if(resource.namePath!==null)paths.push(resource.namePath);}
  requireValue(new Set(value.resources.map(r=>r.key)).size===value.resources.length);
  requireValue(Array.isArray(value.targets)&&value.targets.length>0&&value.targets.length<=8);
  for(const target of value.targets){exact(target,['kind','path']);path(target.path);requireValue(['worker','domain'].includes(target.kind)&&value.fields.some(f=>f.type==='text'&&f.required&&f.path.join('.')===target.path.join('.')));}
  requireValue(new Set(value.targets.map(t=>t.path.join('.'))).size===value.targets.length);
  paths.forEach(path);const names=paths.map(p=>p.join('.'));
  requireValue(names.every((n,i)=>names.every((m,j)=>i===j || (n!==m&&!n.startsWith(m+'.')&&!m.startsWith(n+'.')))));
  requireValue(new TextEncoder().encode(canonicalSba(value)).length<=32768);return structuredClone(value);
}
function label(value){requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=100&&!/[\x00-\x1f]/.test(value));}
export function connectionReference(value) {exact(value,['id','revision']);connectionId(value.id);requireValue(Number.isSafeInteger(value.revision)&&value.revision>0);return value;}
export function deploymentInput(input) {
  const keys=input.action==='application'?['action','github','sourceSha']:['action','github','sourceSha','cloudflare','environment','values','resources'];
  if(Object.hasOwn(input,'repository'))keys.push('repository');
  if(input.action==='preview'&&Object.hasOwn(input,'instance')){keys.push('instance');exact(input.instance,['id','previousTaskId']);for(const value of Object.values(input.instance))requireValue(typeof value==='string'&&/^dc-[a-f0-9]{32}$/.test(value));}
  exact(input,keys);
  requireValue(['application','preview'].includes(input.action));connectionReference(input.github);requireValue(typeof input.sourceSha==='string'&&/^[a-f0-9]{40}$/.test(input.sourceSha));
  if(Object.hasOwn(input,'repository'))requireValue(typeof input.repository==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository));
  if(input.action==='preview'){connectionReference(input.cloudflare);requireValue(typeof input.environment==='string'&&/^[a-z][a-z0-9-]{1,62}$/.test(input.environment)&&object(input.values)&&object(input.resources));}
  return input;
}
function set(root, parts, value){let current=root;for(const part of parts.slice(0,-1)){if(!Object.hasOwn(current,part))current[part]={};requireValue(object(current[part]));current=current[part];}current[parts.at(-1)]=value;}
export function deploymentConfiguration(declaration, values, resources, accountId) {
  const d=deploymentDeclaration(declaration), configuration=structuredClone(d.defaults);
  requireValue(/^[a-f0-9]{32}$/.test(accountId));exact(values,d.fields.map(f=>f.path.join('.')));exact(resources,d.resources.map(r=>r.key));
  set(configuration,d.accountPath,accountId);
  for(const field of d.fields){const value=values[field.path.join('.')];if(field.type==='text')requireValue(typeof value==='string'&&(!field.required||!!value.trim()));else requireValue(!field.required||value!==null);publicValue(value);set(configuration,field.path,value);}
  for(const field of d.resources){const row=resources[field.key];requireValue(row&&row.kind===field.kind&&row.accountId===accountId);set(configuration,field.idPath,row.remoteId);if(field.namePath)set(configuration,field.namePath,row.name);}
  publicValue(configuration);deploymentTargets(d,configuration);requireValue(new TextEncoder().encode(canonicalSba(configuration)).length<=32768);return configuration;
}
export function deploymentTargets(declaration,configuration){return declaration.targets.map(target=>{let value=configuration;for(const part of target.path)value=value?.[part];requireValue(typeof value==='string');if(target.kind==='worker')requireValue(/^[a-z][a-z0-9-]{1,62}$/.test(value));else{const url=new URL(value);requireValue(url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password&&!url.port&&!url.hostname.endsWith('.workers.dev'));}return {kind:target.kind,value};});}
