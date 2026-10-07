import { connectionsEnabled } from './connections-api.mjs';
import { sbaEnabled } from './sba-control.mjs';
import { signSession, sameProof } from './access.mjs';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function adminDeploymentRequest(request,env,session,readBody){
  if(session.automation)return reply({error:'access-denied'},403);
  if(!connectionsEnabled(env)||!sbaEnabled(env))return reply({error:'deployment-disabled'},503);
  const url=new URL(request.url);
  if(request.method!=='POST'||url.pathname!=='/api/admin/deployments/plan')return reply({error:'unknown-route'},404);
  if(request.headers.get('origin')!==session.origin||!sameProof(request.headers.get('x-csrf-token'),await signSession(session,'csrf',null)))return reply({error:'refresh-session'},403);
  try{
    const input=await readBody(request,65536),vault=env.CONNECTIONS.get(env.CONNECTIONS.idFromName(`connections/v1/${session.actor}`));
    const result=await vault.deploymentDraft(session.actor,input);
    if(input.action==='application')return reply(result);
    const expiresAt=Date.now()+120000;
    return reply({draft:input,plan:result,expiresAt,confirmation:await signSession(session,'deployment-confirm',[input,result.digest,expiresAt]),executionEnabled:false});
  }catch{return reply({error:'deployment-plan-rejected-check-source-resources-and-public-configuration'},409);}
}
