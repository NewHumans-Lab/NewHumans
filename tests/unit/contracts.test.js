import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCommandEnvelope, buildCommandEnvelope, toRunCommand } from '../../src/shared/contracts.js';

const actor='00000000-0000-4000-8000-000000000001';

test('canonical command envelope excludes trusted actor/world context',()=>{
  const envelope=buildCommandEnvelope({commandType:'economy.transfer',idempotencyKey:'op-1',payload:{amount_micro_e:'1000000'}});
  assert.deepEqual(envelope,{
    schema_version:'nh.v3.0',
    command_type:'economy.transfer',
    idempotency_key:'op-1',
    payload:{amount_micro_e:'1000000'},
  });
  assert.equal('actor_entity_id' in envelope,false);
  assert.equal('world_id' in envelope,false);
  assert.deepEqual(toRunCommand(envelope,{actorEntityId:actor,worldId:'world-1'}),{
    worldId:'world-1',
    actorEntityId:actor,
    actionType:'economy.transfer',
    idempotencyKey:'op-1',
    payload:{amount_micro_e:'1000000'},
  });
});

test('client-supplied actor/world fields are rejected by the command machine contract',()=>{
  assert.throws(()=>buildCommandEnvelope({commandType:'noop',payload:{}}),(error)=>error.code==='INVALID_COMMAND_ENVELOPE');
  const envelope=buildCommandEnvelope({commandType:'noop',idempotencyKey:'op-2',payload:{}});
  assert.throws(()=>assertCommandEnvelope({...envelope,actor_entity_id:actor}),(error)=>error.code==='INVALID_COMMAND_ENVELOPE');
  assert.throws(()=>assertCommandEnvelope({...envelope,world_id:'world-1'}),(error)=>error.code==='INVALID_COMMAND_ENVELOPE');
  assert.throws(()=>toRunCommand(envelope,{actorEntityId:actor,worldId:''}),(error)=>error.code==='UNAUTHENTICATED_WORLD_CONTEXT');
});
