import { connectedStub, connectedTaskId, accountStub } from './connected-store.mjs';
import { sbaRequest, sbaDigest, canonicalSba, exactSba, requireSba, sbaPolicy } from './sba-control.mjs';
import { createGithubExecutor } from '../src/sba/github.mjs';
import { recoverSbaReceipt } from '../src/sba/artifact.mjs';
import { githubSourcePack, SOURCE_CONTENT_TYPE } from '../src/sba/source.mjs';
import { createSbaOidcVerifier } from './sba-oidc.mjs';
import { sbaMachineRequest } from './sba-api.mjs';
import { signSession, sameProof } from './access.mjs';
import { deploymentTargets } from './deployment-contract.mjs';
import { continuesInstance, createsResources } from './service-preview.mjs';
export const connectedEnabled=env=>env.ENABLE_CONNECTED_DEPLOYMENTS==='yes'&&!!env.CONNECTED_TASKS&&!!env.DEPLOYMENT_LOCKS;
const vaultFor=(env,owner)=>env.CONNECTIONS.get(env.CONNECTIONS.idFromName(`connections/v1/${owner}`));
const reply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const verifyOidc=createSbaOidcVerifier();
function strings(value){return typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];}
function legacyIdentities(value){if(!value||typeof value!=='object')return [];return Object.entries(value).flatMap(([key,item])=>typeof item==='string'&&['name','url','id','kvId','databaseId','bucket','bucketName'].includes(key)?[item]:legacyIdentities(item));}
export async function submitConnected(env,session,input){
  requireSba(connectedEnabled(env));exactSba(input,['taskId','draft','plan','expiresAt','confirmation']);connectedTaskId(input.taskId);
  requireSba(Number.isSafeInteger(input.expiresAt)&&input.expiresAt>Date.now()&&input.expiresAt<=Date.now()+120000&&sameProof(input.confirmation,await signSession(session,'deployment-confirm',[input.taskId,input.draft,input.plan.digest,input.expiresAt])));
  const vault=vaultFor(env,session.actor),existing=(await vault.deploymentIndex(session.actor)).find(row=>row.taskId===input.taskId);
  if(existing){requireSba(existing.digest===input.plan.digest);return connectedState(env,session.actor,input.taskId);}
  let plan;
  try{plan=await vault.deploymentDraft(session.actor,input.draft);}catch(error){
    // A concurrent identical submit can reserve this task while source/parent
    // validation is awaiting I/O. It may only read the already accepted task.
    const race=(await vault.deploymentIndex(session.actor)).find(row=>row.taskId===input.taskId);
    if(race){requireSba(race.digest===input.plan.digest);return connectedState(env,session.actor,input.taskId);}
    throw error;
  }
  requireSba(['preview','rehearse','destroy-preview'].includes(input.draft.action)&&canonicalSba(plan)===canonicalSba(input.plan));
  const accountId=plan.accounts?.runtime.accountId??plan.resources[Object.keys(plan.resources)[0]]?.accountId??(await vault.snapshot(session.actor)).connections.find(r=>r.id===plan.connections.cloudflare.id)?.target;
  requireSba(/^[a-f0-9]{32}$/.test(accountId));
  // 检查最终公开配置，而非只查资源声明；这是配置冲突保护，不是对应用代码的沙箱。
  const legacy=legacyIdentities(sbaPolicy(env).configuration),observed=[...new Set(strings(plan.configuration).filter(s=>s.length<=256))];
  requireSba(observed.length<=256&&observed.every(value=>!legacy.includes(value)));
  const reservation=await vault.reserveDeployment(session.actor,input.taskId,plan);
  if(reservation.alreadyReserved)return connectedState(env,session.actor,input.taskId);
  const accountIds=reservation.accountIds??[accountId],targets=deploymentTargets(plan.application.declaration,plan.configuration);
  for(const id of accountIds){
    const resources=Object.values(plan.resources).filter(row=>row.accountId===id);
    const keys=[...new Set([...resources.flatMap(row=>plan.accounts?[row.name]:[row.remoteId,row.name]),...targets.filter(t=>!t.accountId||t.accountId===id).map(t=>t.value)].map(value=>'identity:'+value))];
    await accountStub(env,id).claim(session.actor,input.taskId,id,`${plan.application.repository}/${plan.policy.environment}`,keys,plan.digest,observed,continuesInstance(plan)?{instanceId:plan.operation.instanceId,previousTaskId:plan.operation.previousTaskId}:null);
  }
  if(createsResources(plan))plan=await vault.provisionDeployment(session.actor,input.taskId,plan);
  // Bind generated IDs as well as names before the runner can receive credentials.
  if(plan.accounts)for(const id of accountIds)await accountStub(env,id).bindCreated(session.actor,input.taskId,plan.digest,Object.values(plan.resources).filter(row=>row.accountId===id).map(row=>'identity:'+row.remoteId),plan.operation?.instanceId??input.taskId);
  const request=sbaRequest(plan.policy,input.taskId,plan.application.manifest,plan.operation??null);
  const stub=connectedStub(env,input.taskId);await stub.initialize(session.actor,input.taskId,plan);
  const claim=await stub.begin(session.actor,{request,manifest:plan.application.manifest});
  if(!claim.dispatch)return {...claim.snapshot,taskId:input.taskId};
  const executor=createGithubExecutor(plan.policy.github,{token:env.SBA_GITHUB_TOKEN});
  const outcome=await executor.dispatch(request,plan.application.manifest);
  return {...await stub.attachRun(session.actor,input.taskId,outcome),taskId:input.taskId};
}
export async function connectedState(env,owner,taskId,reconcile=false){
  connectedTaskId(taskId);const stub=connectedStub(env,taskId);let record;
  try{record=await stub.bootstrap(owner);}catch{
    const entry=(await vaultFor(env,owner).deploymentIndex(owner)).find(r=>r.taskId===taskId);requireSba(entry);
    return {taskId,job:null,status:'preparation-unconfirmed',errorCode:entry.preparation?.errorCode??'DEPLOYMENT_PREPARATION_UNCONFIRMED',preparation:entry.preparation?{phase:entry.preparation.phase,resources:entry.preparation.resources}:null,message:'任务准备未确认，可能存在目标占用或持久状态故障。不要通过新建任务重试。',runUrl:null};
  }
  const policy=record.plan.policy;
  if(reconcile){const job=await stub.inspect(owner);if(job?.status==='running'){
    const outcome=await recoverSbaReceipt(policy.github,job,{token:env.SBA_GITHUB_TOKEN});
    if(outcome.status==='verified-receipt')await stub.settle(owner,outcome.envelope);
    else if(outcome.status==='unknown')await stub.markUnknown(owner,taskId);
  }}
  const snapshot=await stub.snapshot(owner);
  if(['succeeded','deployed-unverified'].includes(snapshot.job?.status)){
    const index=(await vaultFor(env,owner).deploymentIndex(owner)).find(r=>r.taskId===taskId);requireSba(index);for(const id of index.accountIds??[index.accountId])await accountStub(env,id).release(taskId);
  }
  return {...snapshot,taskId,runUrl:snapshot.job?.runId?`https://github.com/${policy.github.repository}/actions/runs/${snapshot.job.runId}`:null};
}
export async function connectedMachineRouter(request,env,readBody){
  let input,bodyError;
  const url=new URL(request.url);
  if(request.method==='POST'&&['/sba/v2/permit','/sba/v2/source'].includes(url.pathname))try{input=await readBody(request);}catch(error){bodyError=error;}
  if(typeof input?.taskId!=='string'||!input.taskId.startsWith('dc-'))return sbaMachineRequest(request,env,async()=>{if(bodyError)throw bodyError;return input;});
  try{
    requireSba(connectedEnabled(env));exactSba(input,['taskId','requestDigest']);connectedTaskId(input.taskId);requireSba(typeof input.requestDigest==='string'&&/^[a-f0-9]{64}$/.test(input.requestDigest));
    const stub=connectedStub(env,input.taskId),record=await stub.bootstrap(),policy=record.plan.policy;
    requireSba(url.origin===policy.runnerOrigin&&!url.search&&!request.headers.has('cookie')&&!request.headers.has('origin'));
    const auth=request.headers.get('authorization');requireSba(typeof auth==='string'&&auth.startsWith('Bearer '));
    const identity=await verifyOidc(auth.slice(7),policy),job=await stub.pending(input.taskId,input.requestDigest);
    requireSba(job.permitId===null&&['dispatching','dispatched','dispatch-unknown'].includes(job.status)&&(job.runId===null||job.runId===identity.runId));
    const executor=createGithubExecutor(policy.github,{token:env.SBA_GITHUB_TOKEN});requireSba((await executor.inspectRun(identity.runId,job.request,job.manifest)).status==='pending');
    const vault=vaultFor(env,record.owner);
    if(url.pathname==='/sba/v2/source'){
      const token=await vault.deploymentCredential(record.owner,input.taskId,'github'),bytes=await githubSourcePack(job.request.repository,job.request.sourceSha,token);
      return new Response(bytes,{headers:{'content-type':SOURCE_CONTENT_TYPE,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
    }
    const mapping=record.plan.credentials??{CLOUDFLARE_API_TOKEN:'cloudflare'};
    requireSba(canonicalSba([...policy.secretNames].sort())===canonicalSba(Object.keys(mapping).sort()));
    const secrets={};for(const name of policy.secretNames)secrets[name]=await vault.deploymentCredential(record.owner,input.taskId,mapping[name]);
    const permit=await stub.permit(input.taskId,input.requestDigest,identity.runId);
    return reply({...permit,secrets});
  }catch{return reply({error:'SBA_PERMIT_DENIED'},403);}
}
