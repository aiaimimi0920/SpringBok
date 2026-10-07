import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentDeclaration, deploymentConfiguration } from '../cloud/deployment-contract.mjs';
export const declaration={schemaVersion:1,target:'cloudflare-workers',accountPath:['accountId'],defaults:{vars:{},server:{name:''}},fields:[{path:['server','name'],label:'Worker 名称',type:'text',required:true},{path:['vars'],label:'公开变量 JSON',type:'json',required:true}],resources:[{key:'database',label:'数据库',kind:'d1',idPath:['database','id'],namePath:['database','name']}]};
test('declaration strictly bounds paths, public values, types and overlapping destinations',()=>{
  assert.deepEqual(deploymentDeclaration(declaration),declaration);
  for(const patch of [{target:'ssh'},{accountPath:['__proto__']},{fields:[{...declaration.fields[0],path:['accountId']}]},{fields:[{...declaration.fields[0],type:'shell'}]},{defaults:{token:'secret'}},{defaults:{constructor:{}}}])assert.throws(()=>deploymentDeclaration({...declaration,...patch}));
});
test('configuration injects observed account and resources; rejects forged or extra fields',()=>{
  const account='a'.repeat(32),values={'server.name':'my-worker',vars:{ENABLED:true}},resources={database:{kind:'d1',accountId:account,remoteId:'remote',name:'db'}};
  const result=deploymentConfiguration(declaration,values,resources,account);assert.equal(result.database.id,'remote');assert.equal(result.database.name,'db');assert.equal(result.accountId,account);
  assert.throws(()=>deploymentConfiguration(declaration,{...values,accountId:'forged'},resources,account));
  assert.throws(()=>deploymentConfiguration(declaration,{...values,vars:{API_TOKEN:'secret'}},resources,account));
  for(const key of ['RESEND_API_KEY','apiKey','authorization','accessKey','PRIVATE_KEY','connectionString']){
    assert.throws(()=>deploymentDeclaration({...declaration,defaults:{vars:{[key]:'synthetic-sensitive'}}}));
    assert.throws(()=>deploymentConfiguration(declaration,{...values,vars:{nested:[{[key]:'synthetic-sensitive'}]}},resources,account));
  }
  assert.throws(()=>deploymentConfiguration(declaration,values,{database:{...resources.database,accountId:'b'.repeat(32)}},account));
});
