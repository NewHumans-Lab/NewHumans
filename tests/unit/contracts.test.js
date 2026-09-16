import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCommandEnvelope, buildCommandEnvelope, toRunCommand } from '../../src/shared/contracts.js';

test('canonical command envelope matches nh.v3.0 field names and keeps actor server-side',()=>{
  const envelope=buildCommandEnvelope({worldId:'world-1',commandType:'economy.transfer',idempotencyKey:'op-1',payload:{amount_micro_e:'1000000'}});
  assert.deepEqual(envelope,{
    schema_version:'nh.v3.0',
    world_id:'world-1',
    command_type:'economy.transfer',
    idempotency_key:'op-1',
    payload:{amount_micro_e:'1000000'},
  });
  assert.equal('actor_entity_id' in envelope,false);
  assert.deepEqual(toRunCommand(envelope,'00000000-0000-4000-8000-000000000001'),{
    worldId:'world-1',
    actorEntityId:'00000000-0000-4000-8000-000000000001',
    actionType:'economy.transfer',
    idempotencyKey:'op-1',
    payload:{amount_micro_e:'1000000'},
  });
});

test('invalid or client-supplied actor fields are rejected by the machine contract',()=>{
  assert.throws(()=>buildCommandEnvelope({worldId:'world-1',commandType:'noop',payload:{}}),(error)=>error.code==='INVALID_COMMAND_ENVELOPE');
  const envelope=buildCommandEnvelope({worldId:'world-1',commandType:'noop',idempotencyKey:'op-2',payload:{}});
  assert.throws(()=>assertCommandEnvelope({...envelope,actor_entity_id:'00000000-0000-4000-8000-000000000001'}),(error)=>error.code==='INVALID_COMMAND_ENVELOPE');
});
