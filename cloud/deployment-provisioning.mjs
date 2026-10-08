import { automaticConfiguration, connectionReference, deploymentTemplate } from './deployment-contract.mjs';
import { canonicalSba, exactSba, requireSba } from './sba-control.mjs';
import { openToken } from './connections-crypto.mjs';
import { readJson } from './connections-provider.mjs';
import { connectedStub } from './connected-store.mjs';
import { serviceSummary } from './service-instance.mjs';

export async function automaticDraft(vault,owner,input,application){
  const declaration=application.declaration,accounts={},connections={github:input.github,cloudflare:input.cloudflare},credentials={},facts={};
  exactSba(input.resources,[]);exactSba(input.accounts??{},declaration.accounts.slice(1).map(a=>a.key));
  for(const account of declaration.accounts){
    const reference=connectionReference(account.key==='runtime'?input.cloudflare:input.accounts[account.key]);
    const {row,sealed}=vault.activeConnection(reference.id,reference.revision);requireSba(row.provider==='cloudflare');
    const connectionKey=account.key==='runtime'?'cloudflare':'cloudflare_'+account.key;
    connections[connectionKey]=reference;credentials[account.secret]=connectionKey;
    accounts[account.key]={accountId:row.target,connection:reference};
    if(!input.instance&&(declaration.fields.some(f=>!Object.hasOwn(input.values,f.path.join('.'))&&f.template?.includes('{subdomain:'+account.key+'}'))||declaration.resources.some(resource=>resource.nameTemplate.includes('{subdomain:'+account.key+'}')))){
      const token=await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY,owner,row,sealed);
      const response=await readJson(`https://api.cloudflare.com/client/v4/accounts/${row.target}/workers/subdomain`,token,false);
      requireSba(response.success===true);facts[account.key]={subdomain:response.result?.subdomain};
    }
  }
  let resources={},values=input.values;
  if(input.instance){
    const prior=await connectedStub(vault.env,input.instance.previousTaskId).bootstrap(owner);
    requireSba(prior.plan.application.declaration.schemaVersion===2);
    resources=structuredClone(prior.plan.resources);
    values={...Object.fromEntries(declaration.fields.map(field=>[field.path.join('.'),field.path.reduce((value,key)=>value?.[key],prior.plan.configuration)])),...input.values};
  }else for(const field of declaration.resources){
    const source=accounts[field.account],name=deploymentTemplate(field.nameTemplate,input.environment,facts);
    requireSba(/^[a-z][a-z0-9-]{1,62}$/.test(name));
    resources[field.key]={provision:true,kind:field.kind,name,remoteId:null,accountId:source.accountId,connectionId:source.connection.id,connectionRevision:source.connection.revision};
  }
  for(const field of declaration.resources){const source=accounts[field.account],row=resources[field.key];requireSba(row&&row.accountId===source.accountId&&row.connectionId===source.connection.id);}
  const configuration=automaticConfiguration(declaration,values,resources,accounts,input.environment,facts);
  for(const reference of Object.values(connections))vault.activeConnection(reference.id,reference.revision);
  return {accounts,connections,credentials,resources,configuration};
}

// A single bounded POST. No retries, redirects, provider error bodies or credentials
// enter durable public records. The caller MUST persist `creating` before this call.
export async function createCloudResource(row,token,transport=fetch,timeoutMs=10000){
  requireSba(/^[a-f0-9]{32}$/.test(row.accountId)&&/^[a-z][a-z0-9-]{1,62}$/.test(row.name));
  const paths={d1:'/d1/database',kv:'/storage/kv/namespaces',r2:'/r2/buckets'};requireSba(Object.hasOwn(paths,row.kind));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let reader;
  try{
    const response=await transport(`https://api.cloudflare.com/client/v4/accounts/${row.accountId}${paths[row.kind]}`,{
      method:'POST',redirect:'manual',signal:controller.signal,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','user-agent':'SpringBok-Provisioning/1.0'},
      body:JSON.stringify(row.kind==='kv'?{title:row.name}:{name:row.name})});
    requireSba([200,201].includes(response.status)&&response.headers.get('content-type')?.includes('application/json')&&response.body);
    reader=response.body.getReader();let size=0;const chunks=[];
    const deadline=new Promise((_,reject)=>{if(controller.signal.aborted)reject(new Error('timeout'));else controller.signal.addEventListener('abort',()=>{void reader.cancel().catch(()=>{});reject(new Error('timeout'));},{once:true});});
    for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;requireSba(size<=65536);chunks.push(value);}
    requireSba(!controller.signal.aborted);
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));requireSba(data.success===true);
    const result=data.result,id=row.kind==='d1'?result?.uuid:row.kind==='kv'?result?.id:result?.name;
    const name=row.kind==='kv'?result?.title:result?.name;
    requireSba(name===row.name&&typeof id==='string'&&(row.kind==='d1'?/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id):row.kind==='kv'?/^[a-f0-9]{32}$/.test(id):id===name));
    return {...row,id:crypto.randomUUID(),revision:1,remoteId:id,checkedAt:Date.now()};
  }finally{clearTimeout(timer);await reader?.cancel().catch(()=>{});}
}

export async function provisionDeployment(vault,owner,taskId,plan){
  const sql=vault.ctx.storage.sql;
  const read=()=>{vault.deploymentGuard(owner);const row=sql.exec('SELECT record FROM connection_deployments WHERE task=?',taskId).one();const record=JSON.parse(row.record);requireSba(record.digest===plan.digest&&canonicalSba(record.preparation.intent)===canonicalSba(plan));return record;};
  const write=record=>sql.exec('UPDATE connection_deployments SET record=? WHERE task=?',JSON.stringify(record),taskId);
  // Taking this flag is synchronous and durable. A second caller, crash or unknown
  // response never takes ownership again, including when no resource was returned.
  vault.ctx.storage.transactionSync(()=>{const record=read();requireSba(record.preparation.phase==='reserved');record.preparation.phase='creating';write(record);});
  let activeKey=null;
  try{
    const resources={};
    for(const [key,row] of Object.entries(plan.resources)){
      activeKey=key;
      const {row:connection,sealed}=vault.activeConnection(row.connectionId,row.connectionRevision);
      const token=await openToken(vault.env.CONNECTIONS_ENCRYPTION_KEY,owner,connection,sealed);
      vault.ctx.storage.transactionSync(()=>{const record=read();vault.activeConnection(row.connectionId,row.connectionRevision);requireSba(!record.preparation.resources[key]);record.preparation.resources[key]={status:'creating',resource:row};write(record);});
      const created=await createCloudResource(row,token);resources[key]=created;
      vault.ctx.storage.transactionSync(()=>{const record=read();requireSba(record.preparation.resources[key].status==='creating');record.preparation.resources[key]={status:'created',resource:created};write(record);});
    }
    const declaration=plan.application.declaration,values=Object.fromEntries(declaration.fields.map(f=>[f.path.join('.'),f.path.reduce((v,k)=>v[k],plan.configuration)]));
    const configuration=automaticConfiguration(declaration,values,resources,plan.accounts,plan.policy.environment);
    const finalized={...plan,resources,configuration,policy:{...plan.policy,configuration}};
    vault.ctx.storage.transactionSync(()=>{const record=read();requireSba(record.preparation.phase==='creating');record.preparation.phase='ready';record.preparation.plan=finalized;record.service=serviceSummary(taskId,finalized);
      for(const row of Object.values(resources))sql.exec('INSERT INTO resources VALUES(?,?,?,?,?)',row.id,row.connectionId,row.kind,row.remoteId,JSON.stringify(row));write(record);});
    return finalized;
  }catch{
    vault.ctx.storage.transactionSync(()=>{const record=read();record.preparation.phase='unknown';record.preparation.errorCode='RESOURCE_CREATION_UNCONFIRMED';if(activeKey&&record.preparation.resources[activeKey]?.status==='creating')record.preparation.resources[activeKey].status='unknown';record.service.resources=Object.fromEntries(Object.entries(plan.resources).map(([key,row])=>[key,record.preparation.resources[key]?.resource??row]));write(record);});
    throw new Error('RESOURCE_CREATION_UNCONFIRMED');
  }
}
