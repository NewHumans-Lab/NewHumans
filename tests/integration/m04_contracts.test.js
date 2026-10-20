import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { acceptContractVersion, proposeContract, publishContractVersion } from '../../src/services/m04_contracts.js';

const pool = createPool();
test.beforeEach(async () => {
  await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE');
});
test.after(async () => pool.end());

async function entity(worldId, type, label) {
  return (await pool.query(
    'INSERT INTO core.entities (world_id,entity_type,display_id,name) VALUES ($1,$2,$3,$4) RETURNING *',
    [worldId,type,label+'-'+crypto.randomUUID(),label],
  )).rows[0];
}
async function fixture() {
  const worldId='nh058-'+crypto.randomUUID();
  const employer=await entity(worldId,'HUMAN','employer');
  const contractor=await entity(worldId,'AGENT','contractor');
  const terms={
    scope:'Implement agreed feature',
    deliverables:[{kind:'repository_commit',description:'tested change'}],
    acceptanceCriteria:{checks:['tests pass','review accepted']},
    priceMicroE:'20000000',
    ruleVersion:'nh.v3.0',
  };
  return {worldId,employer,contractor,terms};
}
async function propose(fx) {
  return withTransaction(pool,(client)=>proposeContract(client,{
    worldId:fx.worldId,actorEntityId:fx.employer.entity_id,
    employerEntityId:fx.employer.entity_id,contractorEntityId:fx.contractor.entity_id,
    ...fx.terms,
  }));
}

test('proposal creates a PROPOSED contract with immutable version 1 and moves no funds',async()=>{
  const fx=await fixture();
  const out=await propose(fx);
  assert.equal(out.status,'PROPOSED');
  assert.equal(out.currentVersion,1);
  assert.equal(out.version.scope,fx.terms.scope);
  assert.equal(String(out.version.price_micro_e),fx.terms.priceMicroE);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.contract_acceptances WHERE world_id=$1',[fx.worldId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.cross_product_outbox WHERE world_id=$1',[fx.worldId])).rows[0].n,0);
});

test('only a party may accept the exact current version and repeated acceptance is idempotent',async()=>{
  const fx=await fixture(),proposal=await propose(fx);
  await assert.rejects(
    ()=>withTransaction(pool,(client)=>acceptContractVersion(client,{
      worldId:fx.worldId,contractId:proposal.contractId,actorEntityId:crypto.randomUUID(),
      expectedVersion:1,idempotencyKey:'unauthorized-'+crypto.randomUUID(),
    })),
    e=>e.code==='FORBIDDEN',
  );
  const first=await withTransaction(pool,(client)=>acceptContractVersion(client,{
    worldId:fx.worldId,contractId:proposal.contractId,actorEntityId:fx.contractor.entity_id,
    expectedVersion:1,idempotencyKey:'accept-'+crypto.randomUUID(),
  }));
  const replay=await withTransaction(pool,(client)=>acceptContractVersion(client,{
    worldId:fx.worldId,contractId:proposal.contractId,actorEntityId:fx.contractor.entity_id,
    expectedVersion:1,idempotencyKey:'accept-replay-'+crypto.randomUUID(),
  }));
  assert.equal(first.accepted,true);
  assert.equal(first.replayed,false);
  assert.equal(replay.replayed,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.contract_acceptances WHERE world_id=$1 AND contract_id=$2',[fx.worldId,proposal.contractId])).rows[0].n,1);
});

test('publishing a new version invalidates old acceptance and rejects stale version writes',async()=>{
  const fx=await fixture(),proposal=await propose(fx);
  await withTransaction(pool,(client)=>acceptContractVersion(client,{
    worldId:fx.worldId,contractId:proposal.contractId,actorEntityId:fx.employer.entity_id,
    expectedVersion:1,idempotencyKey:'accept-'+crypto.randomUUID(),
  }));
  await assert.rejects(
    ()=>withTransaction(pool,(client)=>publishContractVersion(client,{
      worldId:fx.worldId,contractId:proposal.contractId,actorEntityId:fx.contractor.entity_id,
      expectedVersion:0,...fx.terms,changeSummary:'stale edit',
    })),
    e=>e.code==='STALE_VERSION',
  );
  const next=await withTransaction(pool,(client)=>publishContractVersion(client,{
    worldId:fx.worldId,contractId:proposal.contractId,actorEntityId:fx.contractor.entity_id,
    expectedVersion:1,...fx.terms,priceMicroE:'25000000',changeSummary:'Updated agreed scope and price',
  }));
  assert.equal(next.currentVersion,2);
  assert.equal((await pool.query('SELECT invalidated_at FROM social.contract_acceptances WHERE world_id=$1 AND contract_id=$2',[fx.worldId,proposal.contractId])).rows[0].invalidated_at!==null,true);
  const count=await pool.query('SELECT count(*)::int AS n FROM social.contract_acceptances WHERE world_id=$1 AND contract_id=$2 AND version=2 AND invalidated_at IS NULL',[fx.worldId,proposal.contractId]);
  assert.equal(count.rows[0].n,0);
});
