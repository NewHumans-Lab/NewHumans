import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { prepareSagaIntent } from '../../src/services/cross_product_saga_store.js';
import { dispatchSagaOutboxOnce, reconcileSagaOnce } from '../../src/services/cross_product_saga_worker.js';
import { createContractActivationSaga, buildFinancialCommand, SagaState } from '../../src/shared/cross_product_saga.js';
import { ECONOMY_PORT_VERSION } from '../../src/ports/economy_port.js';

const pool = createPool();
const worldPrefix = 'nh054-';
test.afterEach(async () => {
  await pool.query('DELETE FROM social.cross_product_inbox WHERE world_id LIKE $1', [worldPrefix + '%']);
  await pool.query('DELETE FROM social.cross_product_outbox WHERE world_id LIKE $1', [worldPrefix + '%']);
  await pool.query('DELETE FROM social.cross_product_sagas WHERE world_id LIKE $1', [worldPrefix + '%']);
});
test.after(async () => pool.end());

async function prepare() {
  const worldId = worldPrefix + crypto.randomUUID();
  const saga = createContractActivationSaga({
    sagaId: crypto.randomUUID(),
    businessAttemptId: crypto.randomUUID(),
    worldId,
    contractId: crypto.randomUUID(),
    contractVersion: 1,
    escrowRequest: {
      principal_ref: 'principal:employer',
      payload: { contract_ref: 'contract:' + worldId, amount_micro_e: '20000000', prepay_allocations: [] },
    },
  });
  const prepared = await withTransaction(pool, (client) => prepareSagaIntent(client, saga));
  return { saga, prepared, worldId, command: buildFinancialCommand(saga) };
}

function success(request, resultRef = 'kb-escrow:1') {
  return {
    contract_version: ECONOMY_PORT_VERSION,
    operation: 'escrow',
    request_id: request.request_id,
    status: 'SUCCEEDED',
    operation_ref: 'op:escrow:' + resultRef,
    result: { escrow_ref: resultRef, escrow_action: request.payload.escrow_action, amount_micro_e: request.payload.amount_micro_e },
    error: null,
  };
}

test('outbox worker dispatches EconomyPort request and commits authoritative success through Inbox', async () => {
  const fx = await prepare();
  let captured;
  const result = await dispatchSagaOutboxOnce(pool, {
    workerId: 'worker-success',
    worldId: fx.worldId,
    economyPort: { escrow: async (request) => { captured = request; return success(request); } },
  });
  assert.equal(result.outcome, 'DELIVERED');
  assert.equal(captured.operation, 'escrow');
  assert.equal(captured.idempotency_key, fx.command.operation_key);
  assert.equal(captured.payload.escrow_action, 'FUND');
  assert.equal((await pool.query('SELECT state FROM social.cross_product_sagas WHERE saga_id=$1', [fx.saga.saga_id])).rows[0].state, SagaState.REMOTE_SUCCEEDED);
  assert.equal((await pool.query('SELECT status FROM social.cross_product_outbox WHERE outbox_id=$1', [fx.prepared.outbox.outbox_id])).rows[0].status, 'DELIVERED');
  assert.equal((await pool.query('SELECT result_snapshot->>\'result_ref\' AS result_ref FROM social.cross_product_inbox WHERE world_id=$1 AND operation_key=$2', [fx.worldId,fx.command.operation_key])).rows[0].result_ref, 'kb-escrow:1');
});

test('retryable EconomyPort timeout reuses the logical funds key but issues a new transport request id', async () => {
  const fx = await prepare();
  const requests = [];
  const economyPort = { escrow: async (request) => {
    requests.push(request);
    if (requests.length === 1) return {
      contract_version: ECONOMY_PORT_VERSION,
      operation: 'escrow',
      request_id: request.request_id,
      status: 'TIMEOUT',
      result: null,
      error: { code: 'TIMEOUT', retry_with_same_idempotency_key: true },
    };
    return success(request, 'kb-escrow:retry');
  } };
  const first = await dispatchSagaOutboxOnce(pool, { workerId: 'worker-timeout', worldId: fx.worldId, economyPort, retryAfterMs: 1000 });
  assert.equal(first.outcome, 'RETRY_SCHEDULED');
  await pool.query('UPDATE social.cross_product_outbox SET next_attempt_at=now() WHERE outbox_id=$1', [fx.prepared.outbox.outbox_id]);
  const second = await dispatchSagaOutboxOnce(pool, { workerId: 'worker-timeout', worldId: fx.worldId, economyPort });
  assert.equal(second.outcome, 'DELIVERED');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].idempotency_key, requests[1].idempotency_key);
  assert.equal(requests[0].idempotency_key, fx.command.operation_key);
  assert.notEqual(requests[0].request_id, requests[1].request_id);
});

test('ambiguous transport failure blocks resend until authoritative lookup proves absence', async () => {
  const fx = await prepare();
  const dispatch = await dispatchSagaOutboxOnce(pool, {
    workerId: 'worker-unknown',
    worldId: fx.worldId,
    economyPort: { escrow: async () => { throw Object.assign(new Error('socket closed after dispatch'), { code: 'ECONNRESET' }); } },
  });
  assert.equal(dispatch.outcome, 'RECONCILIATION_REQUIRED');
  assert.equal((await pool.query('SELECT state FROM social.cross_product_sagas WHERE saga_id=$1', [fx.saga.saga_id])).rows[0].state, SagaState.RECONCILIATION_REQUIRED);

  await pool.query('UPDATE social.cross_product_sagas SET next_reconcile_at=now() WHERE saga_id=$1', [fx.saga.saga_id]);
  const resolved = await reconcileSagaOnce(pool, {
    workerId: 'reconciler-1',
    lookupOperationByIdempotencyKey: async ({ operationKey, payloadDigest }) => {
      assert.equal(operationKey, fx.command.operation_key);
      assert.equal(payloadDigest, fx.command.payload_digest);
      return { state: 'NOT_FOUND' };
    },
  });
  assert.equal(resolved.outcome, 'SAME_KEY_RETRY_SCHEDULED');
  assert.equal((await pool.query('SELECT status FROM social.cross_product_outbox WHERE outbox_id=$1', [fx.prepared.outbox.outbox_id])).rows[0].status, 'RETRY_WAIT');
  assert.equal((await pool.query('SELECT state FROM social.cross_product_sagas WHERE saga_id=$1', [fx.saga.saga_id])).rows[0].state, SagaState.PENDING_REMOTE);
});

test('reconciliation refuses to run without an authoritative lookup implementation', async () => {
  await assert.rejects(
    () => reconcileSagaOnce(pool, { workerId: 'reconciler-missing' }),
    (error) => error.code === 'KB_RECONCILIATION_UNAVAILABLE',
  );
});
