import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import {
  commitContractActivation,
  commitContractSettlement,
  prepareContractActivation,
  prepareContractSettlement,
} from '../../src/services/contract_saga.js';
import { recordSagaFinancialResult } from '../../src/services/cross_product_saga_store.js';

const pool = createPool();
test.beforeEach(async () => {
  await pool.query("DELETE FROM social.cross_product_inbox WHERE world_id LIKE 'nh053-%'");
  await pool.query("DELETE FROM social.cross_product_outbox WHERE world_id LIKE 'nh053-%'");
  await pool.query("DELETE FROM social.cross_product_sagas WHERE world_id LIKE 'nh053-%'");
  await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE');
});
test.after(async () => pool.end());

async function entity(worldId, type, label) {
  return (await pool.query(
    'INSERT INTO core.entities (world_id,entity_type,display_id,name) VALUES ($1,$2,$3,$4) RETURNING *',
    [worldId,type,label + '-' + crypto.randomUUID(),label],
  )).rows[0];
}
async function fixture() {
  const worldId = 'nh053-' + crypto.randomUUID();
  const employer = await entity(worldId,'HUMAN','employer');
  const contractor = await entity(worldId,'AGENT','contractor');
  const contract = (await pool.query(
    'INSERT INTO social.contracts (world_id,employer_entity_id,contractor_entity_id) VALUES ($1,$2,$3) RETURNING *',
    [worldId,employer.entity_id,contractor.entity_id],
  )).rows[0];
  await addVersion({worldId,contractId:contract.contract_id,authorId:employer.entity_id,version:1,parentVersion:null});
  await pool.query(
    'INSERT INTO social.contract_acceptances (world_id,contract_id,version,party_entity_id,idempotency_key) VALUES ($1,$2,1,$3,$4),($1,$2,1,$5,$6)',
    [worldId,contract.contract_id,employer.entity_id,'employer-accept-'+crypto.randomUUID(),contractor.entity_id,'contractor-accept-'+crypto.randomUUID()],
  );
  return {worldId,employer,contractor,contract};
}
async function addVersion({worldId,contractId,authorId,version,parentVersion}) {
  await pool.query(
    'INSERT INTO social.contract_versions (world_id,contract_id,version,parent_version,scope,deliverables,acceptance_criteria,price_micro_e,rule_version,author_entity_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)',
    [worldId,contractId,version,parentVersion,'scope-v'+version,JSON.stringify([{artifact:'artifact-v'+version}]),JSON.stringify({checks:['reviewed']}),'20000000','nh.v3.0',authorId],
  );
}
function resultFor(outbox, resultRef) {
  const command = outbox.command_snapshot;
  return {operation_key:command.operation_key,payload_digest:command.payload_digest,status:'SUCCEEDED',result_ref:resultRef};
}
async function observe(worldId, outbox, resultRef) {
  const result = resultFor(outbox,resultRef);
  return withTransaction(pool,(client)=>recordSagaFinancialResult(client,{worldId,operationKey:result.operation_key,result}));
}
async function activate(fx) {
  const prepared = await withTransaction(pool,(client)=>prepareContractActivation(client,{
    worldId:fx.worldId,contractId:fx.contract.contract_id,sagaId:crypto.randomUUID(),
    businessAttemptId:crypto.randomUUID(),principalRef:'principal:employer',contractRef:'contract-ref:'+fx.contract.contract_id,
  }));
  await observe(fx.worldId,prepared.outbox,'kb-escrow:'+fx.contract.contract_id);
  const committed = await withTransaction(pool,(client)=>commitContractActivation(client,{worldId:fx.worldId,sagaId:prepared.saga.saga_id}));
  return {prepared,committed};
}

test('activation creates durable intent before dispatch and only commits ACTIVE after confirmed escrow success', async () => {
  const fx = await fixture();
  const prepared = await withTransaction(pool,(client)=>prepareContractActivation(client,{
    worldId:fx.worldId,contractId:fx.contract.contract_id,sagaId:crypto.randomUUID(),
    businessAttemptId:crypto.randomUUID(),principalRef:'principal:employer',contractRef:'contract-ref:'+fx.contract.contract_id,
  }));
  assert.equal(prepared.replayed,false);
  assert.equal(prepared.outbox.status,'PENDING');
  assert.equal((await pool.query('SELECT status FROM social.contracts WHERE contract_id=$1',[fx.contract.contract_id])).rows[0].status,'PROPOSED');
  await assert.rejects(
    () => withTransaction(pool,(client)=>commitContractActivation(client,{worldId:fx.worldId,sagaId:prepared.saga.saga_id})),
    (error)=>error.code==='REMOTE_FUNDING_NOT_CONFIRMED',
  );
  await observe(fx.worldId,prepared.outbox,'kb-escrow:confirmed');
  const completed = await withTransaction(pool,(client)=>commitContractActivation(client,{worldId:fx.worldId,sagaId:prepared.saga.saga_id}));
  assert.equal(completed.contractState,'ACTIVE');
  assert.equal(completed.escrowExternalRef,'kb-escrow:confirmed');
  assert.equal((await pool.query('SELECT status,escrow_external_ref FROM social.contracts WHERE contract_id=$1',[fx.contract.contract_id])).rows[0].status,'ACTIVE');
});

test('activation that becomes permanently ineligible queues REFUND compensation instead of claiming ACTIVE', async () => {
  const fx = await fixture();
  const prepared = await withTransaction(pool,(client)=>prepareContractActivation(client,{
    worldId:fx.worldId,contractId:fx.contract.contract_id,sagaId:crypto.randomUUID(),
    businessAttemptId:crypto.randomUUID(),principalRef:'principal:employer',contractRef:'contract-ref:'+fx.contract.contract_id,
  }));
  await observe(fx.worldId,prepared.outbox,'kb-escrow:compensate');
  await addVersion({worldId:fx.worldId,contractId:fx.contract.contract_id,authorId:fx.employer.entity_id,version:2,parentVersion:1});
  const outcome = await withTransaction(pool,(client)=>commitContractActivation(client,{worldId:fx.worldId,sagaId:prepared.saga.saga_id}));
  assert.equal(outcome.compensationRequired,true);
  assert.equal((await pool.query('SELECT status FROM social.contracts WHERE contract_id=$1',[fx.contract.contract_id])).rows[0].status,'PROPOSED');
  assert.equal(outcome.saga.state,'COMPENSATION_PENDING');
  assert.equal(outcome.outbox.command_snapshot.payload.escrow_action,'REFUND');
});

test('settlement requires frozen escrow allocation, then converges forward to SETTLED', async () => {
  const fx = await fixture();
  await activate(fx);
  await pool.query("UPDATE social.contracts SET status='SUBMITTED' WHERE world_id=$1 AND contract_id=$2",[fx.worldId,fx.contract.contract_id]);
  await pool.query(
    "INSERT INTO social.deliveries (world_id,contract_id,version,submission_no,submitted_by_entity_id,artifact_ref,idempotency_key,status) VALUES ($1,$2,1,1,$3,$4,$5,'ACCEPTED')",
    [fx.worldId,fx.contract.contract_id,fx.contractor.entity_id,'artifact://accepted','delivery-'+crypto.randomUUID()],
  );
  const prepared = await withTransaction(pool,(client)=>prepareContractSettlement(client,{
    worldId:fx.worldId,contractId:fx.contract.contract_id,sagaId:crypto.randomUUID(),
    businessAttemptId:crypto.randomUUID(),principalRef:'principal:employer',contractRef:'contract-ref:'+fx.contract.contract_id,
    escrowRef:'kb-escrow:'+fx.contract.contract_id,
    escrowSnapshot:{
      escrowRef:'kb-escrow:'+fx.contract.contract_id,balanceMicroE:'15000000',
      authorityVersion:'12',receiptRef:'kb-balance-receipt:'+fx.contract.contract_id,
      observedAt:'2026-10-20T08:00:00Z',
    },
    allocations:[{principal_ref:'principal:contractor',amount_micro_e:'15000000'}],
  }));
  assert.equal(prepared.outbox.command_snapshot.payload.escrow_action,'DISTRIBUTE');
  assert.equal(prepared.outbox.command_snapshot.payload.amount_micro_e,'15000000');
  assert.equal(prepared.outbox.command_snapshot.payload.expected_balance_micro_e,'15000000');
  assert.equal(prepared.outbox.command_snapshot.payload.expected_resource_version,'12');
  assert.equal(prepared.outbox.command_snapshot.payload.balance_receipt_ref,'kb-balance-receipt:'+fx.contract.contract_id);
  await observe(fx.worldId,prepared.outbox,'kb-settlement:'+fx.contract.contract_id);
  const committed = await withTransaction(pool,(client)=>commitContractSettlement(client,{worldId:fx.worldId,sagaId:prepared.saga.saga_id}));
  assert.equal(committed.contractState,'SETTLED');
  assert.equal((await pool.query('SELECT status FROM social.contracts WHERE contract_id=$1',[fx.contract.contract_id])).rows[0].status,'SETTLED');
});

test('settlement fails closed when SUBMITTED has no accepted delivery decision', async () => {
  const fx = await fixture();
  await activate(fx);
  await pool.query("UPDATE social.contracts SET status='SUBMITTED' WHERE world_id=$1 AND contract_id=$2",[fx.worldId,fx.contract.contract_id]);
  await assert.rejects(
    () => withTransaction(pool,(client)=>prepareContractSettlement(client,{
      worldId:fx.worldId,contractId:fx.contract.contract_id,sagaId:crypto.randomUUID(),
      businessAttemptId:crypto.randomUUID(),principalRef:'principal:employer',contractRef:'contract-ref:'+fx.contract.contract_id,
      escrowRef:'kb-escrow:'+fx.contract.contract_id,
      allocations:[{principal_ref:'principal:contractor',amount_micro_e:'20000000'}],
    })),
    (error)=>error.code==='CONTRACT_ACCEPTANCE_DECISION_REQUIRED',
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM social.cross_product_outbox WHERE world_id=$1",[fx.worldId])).rows[0].n,1);
});

test('settlement rejects allocations that do not conserve the contract amount', async () => {
  const fx = await fixture();
  await activate(fx);
  await pool.query("UPDATE social.contracts SET status='SUBMITTED' WHERE world_id=$1 AND contract_id=$2",[fx.worldId,fx.contract.contract_id]);
  await pool.query(
    "INSERT INTO social.deliveries (world_id,contract_id,version,submission_no,submitted_by_entity_id,artifact_ref,idempotency_key,status) VALUES ($1,$2,1,1,$3,$4,$5,'ACCEPTED')",
    [fx.worldId,fx.contract.contract_id,fx.contractor.entity_id,'artifact://accepted','delivery-'+crypto.randomUUID()],
  );
  await assert.rejects(
    () => withTransaction(pool,(client)=>prepareContractSettlement(client,{
      worldId:fx.worldId,contractId:fx.contract.contract_id,sagaId:crypto.randomUUID(),
      businessAttemptId:crypto.randomUUID(),principalRef:'principal:employer',contractRef:'contract-ref:'+fx.contract.contract_id,
      escrowRef:'kb-escrow:'+fx.contract.contract_id,
      escrowSnapshot:{
        escrowRef:'kb-escrow:'+fx.contract.contract_id,balanceMicroE:'20000000',
        authorityVersion:'12',receiptRef:'kb-balance-receipt:'+fx.contract.contract_id,
        observedAt:'2026-10-20T08:00:00Z',
      },
      allocations:[{principal_ref:'principal:contractor',amount_micro_e:'19999999'}],
    })),
    (error)=>error.code==='INVALID_CONTRACT_SAGA_INPUT',
  );
});
