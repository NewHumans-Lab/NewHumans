import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import {
  bindKnowledgeBallPrincipal,
  resolveKnowledgeBallPrincipal,
  revokeKnowledgeBallPrincipalBinding,
} from '../../src/services/knowledge_ball_identity_binding.js';

const pool=createPool();
test.beforeEach(async()=>{await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE')});
test.after(async()=>pool.end());

async function entity(worldId,label){
  return (await pool.query(
    "INSERT INTO core.entities (world_id,entity_type,display_id,name) VALUES ($1,'HUMAN',$2,$3) RETURNING *",
    [worldId,label+'-'+crypto.randomUUID(),label],
  )).rows[0];
}
function identityPort(principalRef='kb-principal-'+crypto.randomUUID()){
  return {verifyBindingProof:async input=>{
    assert.equal(typeof input.proof,'string');
    return {provider:'knowledge-ball',principalRef,verificationRef:'kb-verification-'+crypto.randomUUID(),verifiedAt:new Date().toISOString()};
  }};
}

test('binding refuses client-selected principal references and fails closed without trusted KB verifier',async()=>{
  const worldId='nh060-'+crypto.randomUUID(),owner=await entity(worldId,'owner');
  await assert.rejects(()=>bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:owner.entity_id,entityId:owner.entity_id,proof:'proof-token',
    principalRef:'client-chosen-principal',
  },{identityPort:identityPort()}),e=>e.code==='UNTRUSTED_CONTEXT_FIELD');
  await assert.rejects(()=>bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:owner.entity_id,entityId:owner.entity_id,proof:'proof-token',
  }),e=>e.code==='KB_IDENTITY_PROVIDER_UNAVAILABLE');
});

test('trusted verifier result is stored as versioned binding, audited, and resolved without inference',async()=>{
  const worldId='nh060-'+crypto.randomUUID(),owner=await entity(worldId,'owner');
  const canonicalPrincipal='kb-canonical-'+crypto.randomUUID();
  const result=await bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:owner.entity_id,entityId:owner.entity_id,proof:'single-use-proof',
  },{identityPort:identityPort(canonicalPrincipal)});
  assert.equal(result.status,'ACTIVE');
  assert.equal(result.bindingVersion,1);
  const resolved=await withTransaction(pool,client=>resolveKnowledgeBallPrincipal(client,{worldId,entityId:owner.entity_id}));
  assert.equal(resolved.principalRef,canonicalPrincipal);
  assert.equal(resolved.bindingId,result.bindingId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.life_events WHERE world_id=$1 AND event_type='KNOWLEDGE_BALL_PRINCIPAL_BOUND'",[worldId])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM core.outbox WHERE topic='nh.entity.knowledge_ball_principal_bound'")).rows[0].n,1);
});

test('revocation blocks resolution and a verified replacement increments binding version',async()=>{
  const worldId='nh060-'+crypto.randomUUID(),owner=await entity(worldId,'owner');
  const first=await bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:owner.entity_id,entityId:owner.entity_id,proof:'proof-one',
  },{identityPort:identityPort('kb-principal-one-'+crypto.randomUUID())});
  const revoked=await revokeKnowledgeBallPrincipalBinding(pool,{
    worldId,actorEntityId:owner.entity_id,entityId:owner.entity_id,reason:'owner requested relink',
  });
  assert.equal(revoked.status,'REVOKED');
  await assert.rejects(()=>withTransaction(pool,client=>resolveKnowledgeBallPrincipal(client,{worldId,entityId:owner.entity_id})),e=>e.code==='KB_PRINCIPAL_BINDING_REQUIRED');
  const second=await bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:owner.entity_id,entityId:owner.entity_id,proof:'proof-two',
  },{identityPort:identityPort('kb-principal-two-'+crypto.randomUUID())});
  assert.equal(second.bindingVersion,2);
  assert.notEqual(second.bindingId,first.bindingId);
});

test('binding another Entity requires a current explicit capability grant',async()=>{
  const worldId='nh060-'+crypto.randomUUID(),owner=await entity(worldId,'owner'),operator=await entity(worldId,'operator');
  await assert.rejects(()=>bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:operator.entity_id,entityId:owner.entity_id,proof:'proof-token',
  },{identityPort:identityPort()}),e=>e.code==='FORBIDDEN');
  await pool.query(
    "INSERT INTO core.capability_grants (world_id,grantor_entity_id,grantee_entity_id,actions,object_scope) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [worldId,owner.entity_id,operator.entity_id,['identity.bind_knowledge_ball']],
  );
  const result=await bindKnowledgeBallPrincipal(pool,{
    worldId,actorEntityId:operator.entity_id,entityId:owner.entity_id,proof:'proof-token',
  },{identityPort:identityPort()});
  assert.equal(result.status,'ACTIVE');
});
