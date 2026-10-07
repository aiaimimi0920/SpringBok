import test from 'node:test';
import assert from 'node:assert/strict';
import { brandAccounts } from '../cloud/brand-resources.mjs';

test('brand account discovery follows bounded official pagination and rejects incomplete oversized enrollment',async()=>{
  let calls=0;
  const transport=async(url,options)=>{
    calls++;assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts?'));
    const page=Number(new URL(url).searchParams.get('page'));
    return Response.json({success:true,result:Array.from({length:page===2?2:10},(_,i)=>({id:(page*10+i).toString(16).padStart(32,'0'),name:'账户 '+i}))});
  };
  assert.equal((await brandAccounts('cloudflare','synthetic','',transport)).length,12);assert.equal(calls,2);
  await assert.rejects(brandAccounts('cloudflare','synthetic','',async url=>Response.json({success:true,result:Array.from({length:10},(_,i)=>({id:(Number(new URL(url).searchParams.get('page'))*10+i).toString(16).padStart(32,'0'),name:'账户'}))})));
  await assert.rejects(brandAccounts('github','synthetic','',async()=>Response.json({id:1,login:'../invalid'})));
  const selected=await brandAccounts('cloudflare','synthetic','a'.repeat(32),async url=>{assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32));return Response.json({success:true,result:{id:'a'.repeat(32),name:'指定账户'}});});assert.equal(selected[0].target,'a'.repeat(32));
});
