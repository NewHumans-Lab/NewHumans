import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import { firstActivation, mint } from '../../src/services/economy.js';
import { quoteResource, registerConnectorP14, registerDescriptorP14, reserveQuoted } from '../../src/services/p1_4.js';

const pool = createPool();
const world = 'p1-4-billing-immutability';
const today = new Date().toISOString().slice(0, 10);
let system;
let agent;

async function reset() {
  await pool.query(`TRUNCATE gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,economy.resource_quotes,gateway.capability_descriptors,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities RESTART IDENTITY CASCADE`);
  system = await withTransaction(pool, (c) => createEntity(c, { worldId: world, entityType: 'SYSTEM', displayId: 'system', name: 'System' }));
  agent = await withTransaction(pool, (c) => createEntity(c, { worldId: world, entityType: 'AGENT', displayId: `agent-${crypto.randomUUID()}`, name: 'Agent', createdBy: system.entity_id }, { actorEntityId: system.entity_id }));
  await runCommand(pool, { worldId: world, actorEntityId: system.entity_id, actionType: 'economy.mint', idempotencyKey: `mint-${agent.entity_id}`, payload: { amount: '101000000' } }, (c, ctx) => mint(c, { worldId: world, targetEntityId: agent.entity_id, amountMicroE: '101000000', basisKey: `basis-${agent.entity_id}`, actorEntityId: system.entity_id, actionId: ctx.actionId }));
  await runCommand(pool, { worldId: world, actorEntityId: agent.entity_id, actionType: 'economy.first_activation', idempotencyKey: `activate-${agent.entity_id}`, payload: { billingDate: today } }, (c, ctx) => firstActivation(c, { worldId: world, entityId: agent.entity_id, billingDate: today, actorEntityId: agent.entity_id, actionId: ctx.actionId }));
}

async function descriptor(version = 1, inputRate = '1000000', outputRate = '2000000') {
  return withTransaction(pool, (c) => registerDescriptorP14(c, {
    worldId: world,
    actorEntityId: system.entity_id,
    descriptorKey: 'stable-priced-model',
    version,
    modelReference: `test-model-v${version}`,
    maxInputTokens: 4096,
    maxOutputTokens: 256,
    timeoutMs: 1000,
    maxRetries: 3,
    supportsIdempotency: true,
    supportsReconciliation: false,
    inputRateMicroEPerMillion: inputRate,
    outputRateMicroEPerMillion: outputRate,
  }));
}

async function quote(d) {
  return withTransaction(pool, (c) => quoteResource(c, {
    worldId: world,
    payerEntityId: agent.entity_id,
    activitySubjectId: agent.entity_id,
    descriptorId: d.descriptor_id,
    maxInputTokens: 100,
    maxOutputTokens: 10,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    actorEntityId: agent.entity_id,
  }));
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('descriptor pricing contract and accepted quote terms cannot drift in place', async () => {
  const d1 = await descriptor(1, '1000000', '2000000');
  const q1 = await quote(d1);
  assert.equal(q1.max_cost_micro_e, '120');

  await assert.rejects(
    () => pool.query(`UPDATE gateway.capability_descriptors SET input_rate_micro_e_per_million='9000000' WHERE descriptor_id=$1`, [d1.descriptor_id]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE gateway.capability_descriptors SET created_at=created_at + interval '1 second' WHERE descriptor_id=$1`, [d1.descriptor_id]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE economy.resource_quotes SET max_cost_micro_e='999999' WHERE quote_id=$1`, [q1.quote_id]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE economy.resource_quotes SET quote_id=$2 WHERE quote_id=$1`, [q1.quote_id, crypto.randomUUID()]),
    (error) => error.code === '55000',
  );

  const unchanged = (await pool.query(`SELECT input_rate_micro_e_per_million,output_rate_micro_e_per_million FROM gateway.capability_descriptors WHERE descriptor_id=$1`, [d1.descriptor_id])).rows[0];
  assert.equal(unchanged.input_rate_micro_e_per_million, '1000000');
  assert.equal(unchanged.output_rate_micro_e_per_million, '2000000');

  await pool.query(`UPDATE gateway.capability_descriptors SET status='DISABLED' WHERE descriptor_id=$1`, [d1.descriptor_id]);
  const d2 = await descriptor(2, '9000000', '7000000');
  assert.equal(d2.version, 2);
  assert.equal(d2.input_rate_micro_e_per_million, '9000000');

  const oldQuote = (await pool.query(`SELECT resource_ref,input_rate_micro_e_per_million,output_rate_micro_e_per_million,max_cost_micro_e FROM economy.resource_quotes WHERE quote_id=$1`, [q1.quote_id])).rows[0];
  assert.equal(oldQuote.resource_ref, d1.descriptor_id);
  assert.equal(oldQuote.input_rate_micro_e_per_million, '1000000');
  assert.equal(oldQuote.output_rate_micro_e_per_million, '2000000');
  assert.equal(oldQuote.max_cost_micro_e, '120');
});

test('quote binding, execution authority and usage receipts are immutable evidence', async () => {
  const d = await descriptor();
  const connector = await withTransaction(pool, (c) => registerConnectorP14(c, {
    worldId: world,
    actorEntityId: system.entity_id,
    descriptorId: d.descriptor_id,
    connectorKind: 'LOCAL_SELF_HOSTED',
    billingMode: 'PLATFORM_PREPAID',
    baseUrl: 'http://127.0.0.1:9/',
  }));
  const q = await quote(d);
  const reservation = await withTransaction(pool, (c) => reserveQuoted(c, {
    worldId: world,
    entityId: agent.entity_id,
    quoteId: q.quote_id,
    businessKey: `quote-budget-${q.quote_id}`,
    actorEntityId: agent.entity_id,
  }));

  await assert.rejects(
    () => pool.query(`UPDATE economy.reservations SET quote_id=NULL WHERE reservation_id=$1`, [reservation.reservationId]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE economy.resource_quotes SET status='ACTIVE' WHERE quote_id=$1`, [q.quote_id]),
    (error) => error.code === '23514',
  );

  const action = (await pool.query(`INSERT INTO core.actions (world_id,actor_entity_id,action_type,idempotency_key,payload_hash,status) VALUES ($1,$2,'gateway.infer',$3,$4,'PENDING') RETURNING action_id`, [world, agent.entity_id, `manual-${crypto.randomUUID()}`, 'a'.repeat(64)])).rows[0];
  const execution = (await pool.query(`INSERT INTO gateway.executions (world_id,action_id,activity_subject_id,payer_entity_id,descriptor_id,connector_id,reservation_id,quote_id,billing_date,action_purpose,input_digest,max_charge_micro_e,status) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'PRIMARY_INFERENCE',$9,$10,'PROPOSED') RETURNING execution_id,quote_id`, [world, action.action_id, agent.entity_id, d.descriptor_id, connector.connector_id, reservation.reservationId, q.quote_id, today, 'b'.repeat(64), q.max_cost_micro_e])).rows[0];
  assert.equal(execution.quote_id, q.quote_id);

  await assert.rejects(
    () => pool.query(`UPDATE gateway.executions SET quote_id=NULL WHERE execution_id=$1`, [execution.execution_id]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE gateway.executions SET execution_id=$2 WHERE execution_id=$1`, [execution.execution_id, crypto.randomUUID()]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE gateway.executions SET final_charge_micro_e=10 WHERE execution_id=$1`, [execution.execution_id]),
    (error) => error.code === '55000',
  );

  const attempt = (await pool.query(`INSERT INTO gateway.execution_attempts (world_id,execution_id,attempt_no,status) VALUES ($1,$2,1,'STARTED') RETURNING attempt_id`, [world, execution.execution_id])).rows[0];
  const receipt = (await pool.query(`INSERT INTO gateway.usage_receipts (world_id,execution_id,attempt_id,input_tokens,output_tokens,total_tokens,charge_micro_e,external_billing,status,raw_usage) VALUES ($1,$2,$3,4,3,7,10,false,'FINAL','{}'::jsonb) RETURNING receipt_id`, [world, execution.execution_id, attempt.attempt_id])).rows[0];

  await pool.query(`UPDATE gateway.executions SET status='FAILED',final_charge_micro_e=10,completed_at=now() WHERE execution_id=$1`, [execution.execution_id]);
  await assert.rejects(
    () => pool.query(`UPDATE gateway.executions SET final_charge_micro_e=11 WHERE execution_id=$1`, [execution.execution_id]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`UPDATE gateway.executions SET final_charge_micro_e=NULL WHERE execution_id=$1`, [execution.execution_id]),
    (error) => error.code === '55000',
  );

  await assert.rejects(
    () => pool.query(`UPDATE gateway.usage_receipts SET charge_micro_e=11 WHERE receipt_id=$1`, [receipt.receipt_id]),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query(`DELETE FROM gateway.usage_receipts WHERE receipt_id=$1`, [receipt.receipt_id]),
    (error) => error.code === '55000',
  );
});
