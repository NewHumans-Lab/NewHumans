import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { acceptContractVersion, proposeContract } from '../../src/services/m04_contracts.js';
import { raiseContractDispute, reviewDelivery, submitDelivery } from '../../src/services/m04_contract_delivery.js';

const pool=createPool();
test.beforeEach(async()=>{await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE')});
test.after(async()=>pool.end());

async function entity(worldId,type,label){
  return (await pool.query(
    'INSERT INTO core.entities (world_id,entity_type,display_id,name) VALUES ($1,$2,$3,$4) RETURNING *',
    [worldId,type,label+'-'+crypto.randomUUID(),label],
  )).rows[0];
}
async function fixture(){
  const worldId='nh059-'+crypto.randomUUID();
  const employer=await entity(worldId,'HUMAN','employer');
  const contractor=await entity(worldId,'AGENT','contractor');
  const terms={
    scope:'Deliver the agreed feature',
    deliverables:[{kind:'commit',description:'implementation'}],
    acceptanceCriteria:{checks:['tests pass']},
    priceMicroE:'20000000',
    reworkLimit:1,
    ruleVersion:'nh.v3.0',
  };
  const proposal=await withTransaction(pool,(client)=>proposeContract(client,{
    worldId,actorEntityId:employer.entity_id,employerEntityId:employer.entity_id,contractorEntityId:contractor.entity_id,...terms,
  }));
  for(const actorEntityId of [employer.entity_id,contractor.entity_id]){
    await withTransaction(pool,(client)=>acceptContractVersion(client,{
      worldId,contractId:proposal.contractId,actorEntityId,expectedVersion:1,idempotencyKey:'accept-'+crypto.randomUUID(),
    }));
  }
  await pool.query("UPDATE social.contracts SET status='ACTIVE',escrow_external_ref='test-escrow' WHERE world_id=$1 AND contract_id=$2",[worldId,proposal.contractId]);
  return {worldId,employer,contractor,contractId:proposal.contractId};
}
async function submit(fx,artifactRef='artifact://v1',idempotencyKey='delivery-'+crypto.randomUUID()){
  return withTransaction(pool,(client)=>submitDelivery(client,{
    worldId:fx.worldId,contractId:fx.contractId,actorEntityId:fx.contractor.entity_id,
    expectedVersion:1,artifactRef,idempotencyKey,
  }));
}

test('contractor submits delivery once and same-key replay returns original delivery after state transition',async()=>{
  const fx=await fixture(),key='delivery-'+crypto.randomUUID();
  const first=await submit(fx,'artifact://v1',key);
  assert.equal(first.contractStatus,'SUBMITTED');
  assert.equal(first.replayed,false);
  const replay=await submit(fx,'artifact://v1',key);
  assert.equal(replay.replayed,true);
  assert.equal(replay.delivery.delivery_id,first.delivery.delivery_id);
  await assert.rejects(()=>submit(fx,'artifact://different',key),e=>e.code==='IDEMPOTENCY_CONFLICT');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.deliveries WHERE world_id=$1 AND contract_id=$2',[fx.worldId,fx.contractId])).rows[0].n,1);
});

test('only employer can accept delivery and accepted delivery leaves settlement to Saga',async()=>{
  const fx=await fixture(),delivery=(await submit(fx)).delivery;
  await assert.rejects(()=>withTransaction(pool,(client)=>reviewDelivery(client,{
    worldId:fx.worldId,contractId:fx.contractId,deliveryId:delivery.delivery_id,
    actorEntityId:fx.contractor.entity_id,expectedVersion:1,decision:'ACCEPT',
  })),e=>e.code==='FORBIDDEN');
  const reviewed=await withTransaction(pool,(client)=>reviewDelivery(client,{
    worldId:fx.worldId,contractId:fx.contractId,deliveryId:delivery.delivery_id,
    actorEntityId:fx.employer.entity_id,expectedVersion:1,decision:'ACCEPT',
    reviewNote:'Acceptance criteria satisfied',reviewEvidence:{checks:['tests pass']},
  }));
  assert.equal(reviewed.delivery.status,'ACCEPTED');
  assert.equal(reviewed.contractStatus,'SUBMITTED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.cross_product_outbox WHERE world_id=$1',[fx.worldId])).rows[0].n,0);
});

test('rework returns contract to ACTIVE but enforces version rework limit',async()=>{
  const fx=await fixture(),first=(await submit(fx,'artifact://v1')).delivery;
  await withTransaction(pool,(client)=>reviewDelivery(client,{
    worldId:fx.worldId,contractId:fx.contractId,deliveryId:first.delivery_id,
    actorEntityId:fx.employer.entity_id,expectedVersion:1,decision:'REWORK',reviewNote:'Missing required test evidence',
  }));
  const second=(await submit(fx,'artifact://v2')).delivery;
  assert.equal(second.submission_no,2);
  await assert.rejects(()=>withTransaction(pool,(client)=>reviewDelivery(client,{
    worldId:fx.worldId,contractId:fx.contractId,deliveryId:second.delivery_id,
    actorEntityId:fx.employer.entity_id,expectedVersion:1,decision:'REWORK',reviewNote:'Still incomplete',
  })),e=>e.code==='REWORK_LIMIT_EXCEEDED');
});

test('either contract party may raise a version-bound dispute and the contract becomes DISPUTED',async()=>{
  const fx=await fixture(),delivery=(await submit(fx)).delivery;
  const result=await withTransaction(pool,(client)=>raiseContractDispute(client,{
    worldId:fx.worldId,contractId:fx.contractId,actorEntityId:fx.contractor.entity_id,
    expectedVersion:1,deliveryId:delivery.delivery_id,reason:'Acceptance decision conflicts with the published criteria',
    evidence:{artifactRef:delivery.artifact_ref,criterion:'tests pass'},
  }));
  assert.equal(result.contractStatus,'DISPUTED');
  assert.equal(result.dispute.status,'OPEN');
  assert.equal((await pool.query('SELECT status FROM social.deliveries WHERE delivery_id=$1',[delivery.delivery_id])).rows[0].status,'DISPUTED');
});
