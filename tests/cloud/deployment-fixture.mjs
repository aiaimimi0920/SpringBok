import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionsFixture, fakeToken } from './connections-fixture.mjs';
import { policy, manifest, sourceSha } from './sba-fixture.mjs';
export const declaration={schemaVersion:1,target:'cloudflare-workers',accountPath:['accountId'],defaults:{vars:{},server:{name:''}},fields:[{path:['server','name'],label:'Worker 名称',type:'text',required:true},{path:['vars'],label:'公开变量 JSON',type:'json',required:true}],targets:[{kind:'worker',path:['server','name']}],resources:[{key:'database',label:'数据库',kind:'d1',idPath:['database','id'],namePath:['database','name']}]};
export async function deploymentFixture(overrides={}){
  const {f,state}=await connectionsFixture({ENABLE_SBA:'yes',SBA_POLICY:JSON.stringify(policy),SBA_GITHUB_TOKEN:'synthetic-executor',...overrides});
  state.symlink=false;state.declaration=declaration;
  state.provider=async request=>{
    const url=request.url;assert.equal(request.headers.get('authorization'),'Bearer '+fakeToken);
    if(url.endsWith(`/git/commits/${sourceSha}`))return Response.json({sha:sourceSha,tree:{sha:'1'.repeat(40)}});
    if(url.endsWith(`/git/trees/${'1'.repeat(40)}`))return Response.json({sha:'1'.repeat(40),truncated:false,tree:[{path:'.sba',type:'tree',mode:'040000',sha:'2'.repeat(40)}]});
    if(url.endsWith(`/git/trees/${'2'.repeat(40)}`))return Response.json({sha:'2'.repeat(40),truncated:false,tree:[{path:'manifest.json',type:'blob',mode:'100644',sha:'3'.repeat(40)},{path:'deployment.json',type:'blob',mode:state.symlink?'120000':'100644',sha:'4'.repeat(40)}]});
    for(const [sha,value] of [['3'.repeat(40),manifest],['4'.repeat(40),state.declaration]])if(url.endsWith('/git/blobs/'+sha)){const bytes=Buffer.from(JSON.stringify(value));return Response.json({sha,encoding:'base64',size:bytes.length,content:bytes.toString('base64')});}
    return new Response(null,{status:404});
  };
  const token=f.jwt(),auth=(await f.call('/api/admin/state',{token})).json(),session={token,headers:{'x-csrf-token':auth.csrf}};
  const refs={};for(const provider of ['github','cloudflare']){const id=randomUUID(),r=await f.call('/api/admin/connections',{...session,body:{action:'create',id,name:provider,provider,target:provider==='github'?'owner/repo':'a'.repeat(32),token:fakeToken}});assert.equal(r.status,200);refs[provider]={id,revision:1};}
  state.resources={success:true,result:[{uuid:'12345678-1234-1234-1234-123456789abc',name:'test-database'}]};
  const listed=(await f.call('/api/admin/resources',{...session,body:{action:'discover',connectionId:refs.cloudflare.id,kind:'d1',cursor:''}})).json();
  const resource=(await f.call('/api/admin/resources',{...session,body:{action:'register',connectionId:refs.cloudflare.id,kind:'d1',listingId:listed.id,resourceId:listed.items[0].id}})).json().resource;
  const input={action:'preview',github:refs.github,cloudflare:refs.cloudflare,sourceSha,environment:'testing',values:{'server.name':'test-worker',vars:{}},resources:{database:{id:resource.id,revision:resource.revision}}};
  const post=async body=>f.call('/api/admin/deployments/plan',{...session,body});
  return {f,state,session,auth,input,post,resource};
}
