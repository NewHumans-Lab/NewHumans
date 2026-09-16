import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCommandFromRequest, trustedWorldFromRequest } from '../../src/http/trusted-context.js';

function req(headers={}){return{headers};}

test('HTTP adapter binds world from trusted context and keeps it out of the envelope',()=>{
  const request=req({'x-nh-world-id':'world-a','x-nh-actor-id':'00000000-0000-4000-8000-000000000001','idempotency-key':'op-1'});
  const command=canonicalCommandFromRequest(request,{amountMicroE:'1000000'},'economy.reserve');
  assert.equal(command.run.worldId,'world-a');
  assert.equal(command.run.actorEntityId,'00000000-0000-4000-8000-000000000001');
  assert.equal('world_id' in command.envelope,false);
  assert.equal(command.data.worldId,'world-a');
  assert.equal(command.run.payload.worldId,'world-a');
});

test('HTTP adapter rejects missing trusted world and client world claims',()=>{
  assert.throws(()=>trustedWorldFromRequest(req({})),e=>e.code==='UNAUTHENTICATED_WORLD_CONTEXT');
  const request=req({'x-nh-world-id':'world-a','x-nh-actor-id':'00000000-0000-4000-8000-000000000001','idempotency-key':'op-2'});
  assert.throws(()=>canonicalCommandFromRequest(request,{worldId:'world-b'},'noop'),e=>e.code==='UNTRUSTED_CONTEXT_FIELD');
  assert.throws(()=>canonicalCommandFromRequest(request,{world_id:'world-b'},'noop'),e=>e.code==='UNTRUSTED_CONTEXT_FIELD');
});
