import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import {
  claimSagaOutbox,
  markPersistedSagaLocalTransitionCommitted,
  prepareSagaIntent,
  recordSagaFinancialResult,
} from '../../src/services/cross_product_saga_store.js';
import { buildFinancialCommand, createContractActivationSaga, SagaState } from '../../src/shared/cross_product_saga.js';

const pool = createPool();
test.after(async () => pool.end());

function activationSaga() {
  return createContractActivationSaga({
    sagaId: crypto.randomUUID(),
    businessAttemptId: crypto.randomUUID(),
    worldId: 'saga-store-test',
    contractId: crypto.randomUUID(),
    contractVersion: 1,
    escrowRequest: {
      principal_ref: 'principal:employer',
      payload: { contract_ref: 'contract:integration-test', amount_micro_e: '20000000', prepay_allocations: [] },
    },
  });
}

async function prepare(saga) {
  return withTransaction(pool, (client) => prepareSagaIntent(client, saga));
}

function successfulResult(saga, resultRef = 'escrow-test-1') {
  const command = buildFinancialCommand(saga);
  return { operation_key: command.operation_key, payload_digest: command.payload_digest, status: 'SUCCEEDED', result_ref: resultRef };
}

test('Saga prepare persists its immutable intent and outbox in one transaction; replay is idempotent', async () => {
  const saga = activationSaga();
  const first = await prepare(saga);
  const replay = await prepare(saga);
  assert.equal(first.replayed, false);
  assert.equal(first.outbox.status, 'PENDING');
  assert.equal(replay.replayed, true);
  assert.equal(replay.outbox, null);
  assert.equal(replay.saga.saga_id, saga.saga_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.cross_product_sagas WHERE saga_id=$1', [saga.saga_id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.cross_product_outbox WHERE saga_id=$1', [saga.saga_id])).rows[0].n, 1);
});

test('outbox claims are leased and duplicate authoritative results are idempotent', async () => {
  const saga = activationSaga();
  await prepare(saga);
  const claimed = await claimSagaOutbox(pool, { workerId: 'worker-a', leaseMs: 10_000 });
  assert.ok(claimed);
  assert.equal(claimed.saga_id, saga.saga_id);
  assert.equal(claimed.status, 'LEASED');
  assert.equal(await claimSagaOutbox(pool, { workerId: 'worker-b', leaseMs: 10_000 }), null);

  const result = successfulResult(saga);
  const first = await withTransaction(pool, (client) => recordSagaFinancialResult(client, {
    worldId: saga.world_id, operationKey: result.operation_key, result, sourceEventId: 'callback-1',
  }));
  const duplicate = await withTransaction(pool, (client) => recordSagaFinancialResult(client, {
    worldId: saga.world_id, operationKey: result.operation_key, result, sourceEventId: 'callback-duplicate',
  }));
  assert.equal(first.conflict, false);
  assert.equal(first.saga.state, SagaState.REMOTE_SUCCEEDED);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM social.cross_product_inbox WHERE world_id=$1 AND operation_key=$2', [saga.world_id, result.operation_key])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM social.cross_product_outbox WHERE outbox_id=$1', [claimed.outbox_id])).rows[0].status, 'DELIVERED');
});

test('conflicting callback for one operation freezes automated Saga progress for reconciliation', async () => {
  const saga = activationSaga();
  await prepare(saga);
  const result = successfulResult(saga, 'escrow-original');
  await withTransaction(pool, (client) => recordSagaFinancialResult(client, { worldId: saga.world_id, operationKey: result.operation_key, result }));
  const conflict = { ...result, result_ref: 'escrow-conflicting' };
  const outcome = await withTransaction(pool, (client) => recordSagaFinancialResult(client, { worldId: saga.world_id, operationKey: conflict.operation_key, result: conflict }));
  assert.equal(outcome.conflict, true);
  assert.equal((await pool.query('SELECT state FROM social.cross_product_sagas WHERE saga_id=$1', [saga.saga_id])).rows[0].state, SagaState.RECONCILIATION_REQUIRED);
  assert.equal((await pool.query('SELECT status FROM social.cross_product_outbox WHERE saga_id=$1', [saga.saga_id])).rows[0].status, 'RECONCILIATION_REQUIRED');
});

test('confirmed remote success can complete the local Saga transition transactionally', async () => {
  const saga = activationSaga();
  await prepare(saga);
  const result = successfulResult(saga);
  await withTransaction(pool, (client) => recordSagaFinancialResult(client, { worldId: saga.world_id, operationKey: result.operation_key, result }));
  const completed = await withTransaction(pool, (client) => markPersistedSagaLocalTransitionCommitted(client, {
    worldId: saga.world_id, sagaId: saga.saga_id, localContractState: 'ACTIVE',
  }));
  assert.equal(completed.state, SagaState.COMPLETED);
  assert.equal((await pool.query('SELECT state,version FROM social.cross_product_sagas WHERE saga_id=$1', [saga.saga_id])).rows[0].state, SagaState.COMPLETED);
});
