import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import { getWallet, mint } from '../../src/services/economy.js';

const pool=createPool();
async function reset(){
  await pool.query('TRUNCATE core.consumer_receipts, core.outbox, core.life_events, economy.activity_fees, economy.activity_subjects, economy.reservations, economy.postings, economy.journals, economy.wallets, core.actions, core.capability_grants, core.entities RESTART IDENTITY CASCADE');
}
async function entity(worldId,entityType,name,createdBy=null){
  return withTransaction(pool,(client)=>createEntity(client,{worldId,entityType,displayId:`${name}-${crypto.randomUUID()}`,name,createdBy},{actorEntityId:createdBy}));
}
async function mintTo(worldId,system,target,amount,basis){
  return runCommand(pool,{worldId,actorEntityId:system.entity_id,actionType:'economy.mint',idempotencyKey:`mint-${basis}`,payload:{target:target.entity_id,amount,basis}},(client,ctx)=>mint(client,{worldId,targetEntityId:target.entity_id,amountMicroE:amount,basisKey:basis,actorEntityId:system.entity_id,actionId:ctx.actionId}));
}
test.beforeEach(reset); test.after(async()=>pool.end());

test('world/entity relationships are enforced by composite foreign keys',async()=>{
  const systemA=await entity('world-a','SYSTEM','system-a');
  const agentB=await entity('world-b','AGENT','agent-b');
  await assert.rejects(
    ()=>pool.query(`INSERT INTO core.actions (world_id,actor_entity_id,action_type,idempotency_key,payload_hash,status) VALUES ('world-a',$1,'probe','cross-world',$2,'PENDING')`,[agentB.entity_id,'0'.repeat(64)]),
    (error)=>error.code==='23503',
  );
  await assert.rejects(
    ()=>pool.query(`INSERT INTO economy.wallets (world_id,entity_id) VALUES ('world-a',$1)`,[agentB.entity_id]),
    (error)=>error.code==='23503',
  );
  assert.ok(systemA.entity_id);
});

test('posting world guard rejects an entity from another world',async()=>{
  const systemA=await entity('world-a','SYSTEM','system-a');
  const agentA=await entity('world-a','AGENT','agent-a',systemA.entity_id);
  const agentB=await entity('world-b','AGENT','agent-b');
  await mintTo('world-a',systemA,agentA,'10000000','world-guard-seed');
  const journal=(await pool.query(`SELECT journal_id FROM economy.journals WHERE world_id='world-a' AND business_key='mint:world-guard-seed'`)).rows[0];
  await assert.rejects(
    ()=>pool.query(`INSERT INTO economy.postings (journal_id,account_type,entity_id,amount_micro_e) VALUES ($1,'ENTITY_WALLET',$2,1)`,[journal.journal_id,agentB.entity_id]),
    (error)=>error.code==='23514',
  );
});

test('committed journals and postings are immutable and cannot be extended',async()=>{
  const system=await entity('world-a','SYSTEM','system');
  const agent=await entity('world-a','AGENT','agent',system.entity_id);
  await mintTo('world-a',system,agent,'10000000','append-only-seed');
  const journal=(await pool.query(`SELECT journal_id FROM economy.journals WHERE world_id='world-a' AND business_key='mint:append-only-seed'`)).rows[0];
  const posting=(await pool.query('SELECT posting_id FROM economy.postings WHERE journal_id=$1 ORDER BY posting_id LIMIT 1',[journal.journal_id])).rows[0];

  await assert.rejects(()=>pool.query('UPDATE economy.postings SET amount_micro_e=amount_micro_e+1 WHERE posting_id=$1',[posting.posting_id]),(error)=>error.code==='55000');
  await assert.rejects(()=>pool.query('DELETE FROM economy.postings WHERE posting_id=$1',[posting.posting_id]),(error)=>error.code==='55000');
  await assert.rejects(()=>pool.query('UPDATE economy.journals SET business_key=business_key WHERE journal_id=$1',[journal.journal_id]),(error)=>error.code==='55000');
  await assert.rejects(()=>pool.query('DELETE FROM economy.journals WHERE journal_id=$1',[journal.journal_id]),(error)=>error.code==='55000');

  await assert.rejects(()=>withTransaction(pool,async(client)=>{
    await client.query(`INSERT INTO economy.postings (journal_id,account_type,system_account,amount_micro_e) VALUES ($1,'SYSTEM','EXTRA_A',-1)`,[journal.journal_id]);
    await client.query(`INSERT INTO economy.postings (journal_id,account_type,system_account,amount_micro_e) VALUES ($1,'SYSTEM','EXTRA_B',1)`,[journal.journal_id]);
  }),(error)=>error.code==='23514');
  assert.equal((await pool.query('SELECT count(*)::int n FROM economy.postings WHERE journal_id=$1',[journal.journal_id])).rows[0].n,2);
});

test('empty or incomplete journals cannot commit',async()=>{
  await assert.rejects(()=>withTransaction(pool,(client)=>client.query(`INSERT INTO economy.journals (world_id,business_key,journal_type) VALUES ('world-a','empty-journal','MINT')`)),(error)=>error.code==='23514');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM economy.journals WHERE business_key='empty-journal'`)).rows[0].n,0);
});

test('same ledger business key with different content is an idempotency conflict',async()=>{
  const system=await entity('world-a','SYSTEM','system');
  const agent=await entity('world-a','AGENT','agent',system.entity_id);
  await mintTo('world-a',system,agent,'10000000','same-basis');
  await assert.rejects(
    ()=>runCommand(pool,{worldId:'world-a',actorEntityId:system.entity_id,actionType:'economy.mint',idempotencyKey:'different-action',payload:{target:agent.entity_id,amount:'20000000',basis:'same-basis'}},(client,ctx)=>mint(client,{worldId:'world-a',targetEntityId:agent.entity_id,amountMicroE:'20000000',basisKey:'same-basis',actorEntityId:system.entity_id,actionId:ctx.actionId})),
    (error)=>error.code==='IDEMPOTENCY_CONFLICT',
  );
  const wallet=await withTransaction(pool,(client)=>getWallet(client,'world-a',agent.entity_id));
  assert.equal(wallet.posted_balance_micro_e,'10000000');
});
