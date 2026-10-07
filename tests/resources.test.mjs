import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceInput, discoverResources } from '../cloud/resources.mjs';
const account = 'a'.repeat(32), id = '12345678-1234-1234-1234-123456789abc';
test('resource input rejects arbitrary provider, account, URL, cursor and unknown fields', () => {
  const input = { action:'discover', connectionId:'12345678-1234-4234-8234-123456789abc', kind:'d1', cursor:'' };
  assert.deepEqual(resourceInput(input), input);
  for (const change of [{kind:'ssh'}, {cursor:'1&account=evil'}, {accountId:account}, {action:'delete'}, {connectionId:'https://evil.invalid'}]) assert.throws(() => resourceInput({...input,...change}));
});
test('D1/KV paging is bounded, account-scoped and whitelists response fields', async () => {
  for (const kind of ['d1','kv']) {
    const rows=Array.from({length:100},(_,i)=>kind==='d1'?{uuid:`12345678-1234-1234-1234-${String(i).padStart(12,'0')}`,name:'database',token:'not-output'}:{id:i.toString(16).padStart(32,'0'),title:'namespace'});
    let url; const transport=async (u,opts)=>{url=u;assert.equal(opts.method,'GET');assert.equal(opts.redirect,'manual');return Response.json({success:true,result:rows,result_info:{page:2}});};
    const result=await discoverResources(account,'synthetic',kind,'2',transport);
    assert.equal(result.next,'3');assert.ok(url.includes(`/accounts/${account}/`));assert.ok(url.endsWith('page=2'));assert.deepEqual(Object.keys(result.items[0]),['id','name']);
  }
});
test('R2 uses start_after and rejects malformed, duplicate, unsorted or foreign-page records', async () => {
  let url; const result=await discoverResources(account,'synthetic','r2','bucket-a',async u=>{url=u;return Response.json({success:true,result:{buckets:[{name:'bucket-b'}]}});});
  assert.equal(result.next,null);assert.ok(url.endsWith('start_after=bucket-a'));
  for(const buckets of [[{name:'bucket-a'}],[{name:'bucket-c'},{name:'bucket-b'}],[{name:'bucket-b'},{name:'bucket-b'}],[{name:'invalid/bucket'}]]) await assert.rejects(discoverResources(account,'synthetic','r2','bucket-a',async()=>Response.json({success:true,result:{buckets}})));
  await assert.rejects(discoverResources(account,'synthetic','d1','1',async()=>Response.json({success:true,result:[{uuid:id,name:'x'}],result_info:{page:2}})));
});
