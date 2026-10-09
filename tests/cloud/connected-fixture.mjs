import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deploymentFixture } from './deployment-fixture.mjs';
import { fakeToken } from './connections-fixture.mjs';
import { policy, sha } from './sba-fixture.mjs';
import { zip } from '../sba-zip-fixture.mjs';
import { SOURCE_CONTENT_TYPE } from '../../src/sba/source.mjs';
export async function connectedFixture(overrides={}){
  const fixture=await deploymentFixture({ENABLE_CONNECTED_DEPLOYMENTS:'yes',...overrides}),{f,state,session,post,input}=fixture,sourceProvider=state.provider;
  Object.assign(state,{executorSha:sha,dispatches:0,runStatus:'in_progress',badTitle:false,dispatchLost:false});
  state.provider=async(request,context)=>{
    const url=request.url;if(url==='https://token.actions.githubusercontent.com/.well-known/jwks')return Response.json({keys:[context.jwk]});
    if(url==='https://github.com/owner/repo.git/git-upload-pack'){assert.equal(request.headers.get('authorization'),`Basic ${Buffer.from('x-access-token:'+fakeToken).toString('base64')}`);return new Response('synthetic-source',{headers:{'content-type':SOURCE_CONTENT_TYPE}});}
    if(!url.startsWith('https://api.github.com/repos/owner/executor/')&&!url.startsWith('https://synthetic.blob.core.windows.net/'))return sourceProvider(request,context);
    if(url.startsWith('https://api.github.com/'))assert.equal(request.headers.get('authorization'),'Bearer synthetic-executor');
    if(url.endsWith('/actions/workflows/99/dispatches')){state.dispatches++;const body=await request.json();state.executorSha=body.inputs.executor_sha;assert.equal(body.ref,`sba-executor-${state.executorSha}`);state.request=JSON.parse(body.inputs.request_json);state.digest=body.inputs.request_sha256;assert.ok(!JSON.stringify(body).includes(fakeToken));if(state.dispatchLost)return new Response(null,{status:503});return Response.json({workflow_run_id:456,run_url:'https://api.github.com/repos/owner/executor/actions/runs/456',html_url:'https://github.com/owner/executor/actions/runs/456'});}
    if(url.endsWith('/actions/runs/456'))return Response.json({id:456,workflow_id:99,event:'workflow_dispatch',head_sha:state.executorSha,head_branch:`sba-executor-${state.executorSha}`,path:policy.github.workflowPath,run_attempt:1,repository:{id:123,full_name:policy.github.repository},head_repository:{id:123,full_name:policy.github.repository},display_title:state.badTitle?'wrong':`sba:${state.request.taskId}:${state.digest}`,pull_requests:[],status:state.runStatus,conclusion:state.runStatus==='completed'?'success':null});
    if(url.endsWith('/actions/runs/456/artifacts?per_page=100'))return Response.json({total_count:1,artifacts:[{id:789,name:`sba-result-${state.request.taskId}-${state.digest}`,expired:false,size_in_bytes:state.archive.length,digest:`sha256:${createHash('sha256').update(state.archive).digest('hex')}`,workflow_run:{id:456,repository_id:123,head_repository_id:123,head_sha:state.executorSha,head_branch:`sba-executor-${state.executorSha}`}}]});
    if(url.endsWith('/actions/artifacts/789/zip'))return new Response(null,{status:302,headers:{location:'https://synthetic.blob.core.windows.net/receipt?sig=test'}});
    if(url==='https://synthetic.blob.core.windows.net/receipt?sig=test'){assert.equal(request.headers.get('authorization'),null);return new Response(state.archive);}
    return new Response(null,{status:404});
  };
  const api=(route,body)=>f.call('/api/admin/deployments/'+route,{...session,body});
  const preview=async()=>{const r=await post(input);assert.equal(r.status,200,r.text);return r.json();};
  const submit=preview=>{const {executionEnabled,...body}=preview;return api('submit',body);};
  const token=(patch={})=>{const now=Math.floor(Date.now()/1000),ref=`refs/tags/sba-executor-${state.executorSha}`;return f.jwt({iss:'https://token.actions.githubusercontent.com',aud:`${policy.runnerOrigin}/sba/v2/permit`,sub:`repo:${policy.github.repository}:ref:${ref}`,jti:'test',iat:now,nbf:now,exp:now+300,repository:policy.github.repository,repository_id:'123',workflow_sha:state.executorSha,sha:state.executorSha,ref,ref_type:'tag',workflow_ref:`${policy.github.repository}/${policy.github.workflowPath}@${ref}`,event_name:'workflow_dispatch',runner_environment:'github-hosted',run_id:'456',run_attempt:'1',...patch});};
  const machine=(route='permit',extra={})=>f.mf.dispatchFetch(`${policy.runnerOrigin}/sba/v2/${route}`,{method:'POST',headers:{authorization:`Bearer ${token()}`,'content-type':'application/json'},body:JSON.stringify({taskId:state.request.taskId,requestDigest:state.digest}),...extra});
  const receipt=(permit,status='succeeded',extra={})=>{const r=state.request;state.archive=zip({schemaVersion:1,runId:456,runAttempt:1,executorSha:state.executorSha,requestDigest:state.digest,permitId:permit.permitId,result:{schemaVersion:r.schemaVersion,taskId:r.taskId,action:r.action,sourceSha:r.sourceSha,applicationVersion:r.applicationVersion,status,checks:[{id:'synthetic-check',passed:status==='succeeded'}],...(status==='unknown'?{errorCode:'TEST_UNCERTAIN'}:{}),...extra}});state.runStatus='completed';};
  return {...fixture,api,preview,submit,token,machine,receipt};
}
