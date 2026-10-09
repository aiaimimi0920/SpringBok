import { connectionsEnabled } from './connections-api.mjs';
import { sbaEnabled } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';
import { connectedEnabled, submitConnected, connectedState } from './connected-api.mjs';
import { exactSba } from './sba-control.mjs';
import { serviceIndex, serviceState } from './service-api.mjs';
import { serviceImportRequest } from './service-import-api.mjs';
import { serviceDeletionRequest } from './service-deletion-api.mjs';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function adminDeploymentRequest(request,env,session,readBody){
  if(session.automation)return reply({error:'access-denied'},403);
  if(!connectionsEnabled(env)||!sbaEnabled(env))return reply({error:'deployment-disabled'},503);
  const url=new URL(request.url);
  const vault=env.CONNECTIONS.get(env.CONNECTIONS.idFromName(`connections/v1/${session.actor}`));
  if(request.method==='GET'&&url.pathname==='/api/admin/deployments'){
    try{return reply({tasks:(await vault.deploymentIndex(session.actor)).map(({taskId,createdAt})=>({taskId,createdAt})),executionEnabled:connectedEnabled(env)});}catch{return reply({error:'deployment-index-unavailable'},409);}
  }
  if(request.method==='GET'&&url.pathname==='/api/admin/deployments/services'){
    try{return reply({services:await serviceIndex(vault,session.actor),executionEnabled:connectedEnabled(env)});}catch{return reply({error:'service-index-unavailable'},409);}
  }
  if(request.method!=='POST'||!['plan','submit','state','reconcile','catalog','versions','application','service-state','import-preview','import-submit','delete-plan','delete-submit'].some(route=>url.pathname==='/api/admin/deployments/'+route))return reply({error:'unknown-route'},404);
  if(request.headers.get('origin')!==session.origin||!sameProof(request.headers.get('x-csrf-token'),await signSession(session,'csrf',null)))return reply({error:'refresh-session'},403);
  try{
    const input=await readBody(request,131072);
    if (['delete-plan','delete-submit'].some(route => url.pathname.endsWith('/' + route))) return reply(await serviceDeletionRequest(env, vault, session, url.pathname.split('/').at(-1), input));
    if (['import-preview','import-submit'].some(route => url.pathname.endsWith('/' + route))) return reply(await serviceImportRequest(env, session, url.pathname.split('/').at(-1), input));
    if(['catalog','versions','application'].some(route=>url.pathname.endsWith('/'+route)))return reply(await vault.serviceCatalog(session.actor,url.pathname.split('/').at(-1),input));
    if(url.pathname.endsWith('/service-state'))return reply(await serviceState(env,vault,session.actor,input));
    if(url.pathname.endsWith('/submit'))return reply(await submitConnected(env,session,input));
    if(url.pathname.endsWith('/state')||url.pathname.endsWith('/reconcile')){exactSba(input,['taskId']);return reply(await connectedState(env,session.actor,input.taskId,url.pathname.endsWith('/reconcile')));}
    const result=await vault.deploymentDraft(session.actor,input);
    if(input.action==='application')return reply(result);
    const expiresAt=Date.now()+120000,taskId='dc-'+crypto.randomUUID().replaceAll('-','');
    return reply({taskId,draft:input,plan:result,expiresAt,confirmation:await signSession(session,'deployment-confirm',[taskId,input,result.digest,expiresAt]),executionEnabled:connectedEnabled(env)});
  }catch{return reply({error:'deployment-plan-rejected-check-source-resources-and-public-configuration'},409);}
}
