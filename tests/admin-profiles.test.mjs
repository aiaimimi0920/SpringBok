import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapConfiguration, bootstrapCredential } from '../cloud/admin-profiles.mjs';
test('update preserves bootstrap identity and non-deploy actions never decrypt its password',async()=>{
  const vault={ctx:{storage:{sql:{exec(){throw new Error('unexpected secret read');}}}}};
  const declaration={administrator:{emailPath:['admin','bootstrapEmail'],secret:'ADMIN_BOOTSTRAP_PASSWORD'}};
  const configuration={admin:{}},credentials={};
  bootstrapConfiguration(vault,'owner',{instance:{}},declaration,configuration,credentials,{admin:{bootstrapEmail:'fixture@gmail.com'}});
  assert.deepEqual(configuration,{admin:{bootstrapEmail:'fixture@gmail.com'}});
  assert.equal(credentials.ADMIN_BOOTSTRAP_PASSWORD,'bootstrap-disabled');
  for(const action of ['update','preview','verify','destroy-preview']){
    assert.equal(await bootstrapCredential(vault,'owner',{service:{action},credentials:{ADMIN_BOOTSTRAP_PASSWORD:'bootstrap:private-id'}},'bootstrap:private-id'),'bootstrap-not-applicable');
  }
  await assert.rejects(bootstrapCredential(vault,'owner',{service:{action:'update'},credentials:{}},'bootstrap:forged'));
  assert.throws(()=>bootstrapConfiguration(vault,'owner',{instance:{},administrator:{}},declaration,{},{}));
});
