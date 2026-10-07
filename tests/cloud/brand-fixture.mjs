import { connectionsFixture } from './connections-fixture.mjs';
export async function brandFixture() {
  const fixture=await connectionsFixture(),{state}=fixture;
  state.provider=async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/client/v4/accounts')return Response.json({success:true,result:[{id:'a'.repeat(32),name:'团队账户'},{id:'b'.repeat(32),name:'个人账户'}]});
    if(url.pathname.endsWith('/workers/scripts'))return Response.json({success:true,result:[{id:'existing-worker'}]});
    if(url.pathname.endsWith('/d1/database'))return Response.json({success:true,result:[{uuid:'12345678-1234-1234-1234-123456789abc',name:'业务数据库'}]});
    if(url.pathname.endsWith('/storage/kv/namespaces'))return Response.json({success:true,result:[{id:'1'.repeat(32),title:'应用缓存'}]});
    if(url.pathname.endsWith('/r2/buckets'))return state.r2Denied?Response.json({error:'denied'},{status:403}):Response.json({success:true,result:{buckets:[{name:'app-files'}]}});
    if(url.pathname==='/user/repos')return Response.json([{id:2,full_name:'owner/repo'},{id:3,full_name:'team/archive',archived:true},{id:4,full_name:'owner/.github'}]);
    return Response.json({}, {status:404});
  };
  return fixture;
}
