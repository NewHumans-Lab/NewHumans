import test from 'node:test';
import assert from 'node:assert/strict';
import { payloadDigest } from '../../src/integrations/knowledge-ball/idempotency-retry.js';
import {
  ECONOMY_PORT_VERSION,
  assertEconomyPortRequest,
} from '../../src/ports/economy_port.js';
import {
  SagaState,
  buildEconomyPortRequest,
  buildFinancialCommand,
  createContractActivationSaga,
  createContractSettlementSaga,
  digestSagaPayload,
  markLocalTransitionCommitted,
  observeFinancialResult,
  reconciliationPlan,
  requestActivationCompensation,
} from '../../src/shared/cross_product_saga.js';

function activationSaga(overrides = {}) {
  return createContractActivationSaga({
    sagaId: 'saga-activation-1',
    businessAttemptId: 'accept-contract-command-1',
    worldId: 'world-1',
    contractId: 'contract-1',
    contractVersion: 7,
    escrowRequest: {
      principal_ref: 'principal:employer',
      payload: {
        contract_ref: 'contract:contract-1',
        amount_micro_e: '20000000',
        prepay_allocations: [],
      },
    },
    ...overrides,
  });
}

function settlementSaga(overrides = {}) {
  return createContractSettlementSaga({
    sagaId: 'saga-settlement-1',
    businessAttemptId: 'review-contract-command-1',
    worldId: 'world-1',
    contractId: 'contract-1',
    contractVersion: 7,
    settlementRequest: {
      principal_ref: 'principal:employer',
      payload: {
        contract_ref: 'contract:contract-1',
        amount_micro_e: '20000000',
        escrow_ref: 'escrow-1',
        allocations: [
          { principal_ref: 'principal:contractor', amount_micro_e: '18000000' },
          { principal_ref: 'principal:employer', amount_micro_e: '2000000' },
        ],
      },
    },
    ...overrides,
  });
}

function successFor(command, resultRef) {
  return {
    operation_key: command.operation_key,
    payload_digest: command.payload_digest,
    status: 'SUCCEEDED',
    result_ref: resultRef,
  };
}

test('financial intent survives crash points and produces valid NH-005 EconomyPort attempts with NH-009 identity', () => {
  const saga = activationSaga();
  const afterPrepareCommitBeforeSend = buildFinancialCommand(saga);
  const afterSendBeforeKbCommit = buildFinancialCommand(saga);
  const afterResponseLossBeforeObservation = buildFinancialCommand(saga);

  assert.deepEqual(afterSendBeforeKbCommit, afterPrepareCommitBeforeSend);
  assert.deepEqual(afterResponseLossBeforeObservation, afterPrepareCommitBeforeSend);
  assert.equal(afterPrepareCommitBeforeSend.operation, 'escrow');
  assert.equal(afterPrepareCommitBeforeSend.payload.escrow_action, 'FUND');
  assert.equal('escrow_action' in afterPrepareCommitBeforeSend, false);
  assert.equal(afterPrepareCommitBeforeSend.operation_class, 'FUNDS_WRITE');
  assert.equal(afterPrepareCommitBeforeSend.economy_port_contract_version, ECONOMY_PORT_VERSION);
  assert.equal(afterPrepareCommitBeforeSend.kb_idempotency_contract_version, 'nh.kb-idempotency.v1');
  assert.equal(afterPrepareCommitBeforeSend.idempotency_key, afterPrepareCommitBeforeSend.operation_key);
  assert.equal(afterPrepareCommitBeforeSend.correlation_id, saga.business_attempt_id);
  assert.equal(
    afterPrepareCommitBeforeSend.payload_digest,
    payloadDigest({
      principal_ref: afterPrepareCommitBeforeSend.principal_ref,
      payload: afterPrepareCommitBeforeSend.payload,
    }),
  );

  const firstAttempt = buildEconomyPortRequest(saga, { requestId: 'request-1', expectedVersion: '7' });
  const retryAttempt = buildEconomyPortRequest(saga, { requestId: 'request-2', expectedVersion: '7' });
  assert.equal(assertEconomyPortRequest('escrow', firstAttempt), firstAttempt);
  assert.equal(assertEconomyPortRequest('escrow', retryAttempt), retryAttempt);
  assert.notEqual(firstAttempt.request_id, retryAttempt.request_id);
  assert.equal(firstAttempt.idempotency_key, retryAttempt.idempotency_key);
  assert.equal(firstAttempt.principal_ref, retryAttempt.principal_ref);
  assert.deepEqual(firstAttempt.payload, retryAttempt.payload);
  assert.equal(firstAttempt.payload.escrow_action, 'FUND');
  assert.deepEqual(reconciliationPlan(saga), {
    action: 'QUERY_PRIMARY_THEN_RETRY_SAME_KEY',
    operation_key: afterPrepareCommitBeforeSend.operation_key,
  });
});

test('same business attempt keeps the same funds key even if a duplicate coordinator row gets a different saga id', () => {
  const first = activationSaga({ sagaId: 'saga-a' });
  const accidentalDuplicate = activationSaga({ sagaId: 'saga-b' });
  assert.notEqual(first.saga_id, accidentalDuplicate.saga_id);
  assert.equal(first.business_attempt_id, accidentalDuplicate.business_attempt_id);
  assert.equal(buildFinancialCommand(first).idempotency_key, buildFinancialCommand(accidentalDuplicate).idempotency_key);
});

test('KB success followed by NH commit failure recovers without a second escrow funding', () => {
  const beforeNhCommit = activationSaga();
  const command = buildFinancialCommand(beforeNhCommit);
  const kbResult = successFor(command, 'escrow-1');

  const lostNhAttempt = observeFinancialResult(beforeNhCommit, kbResult);
  assert.equal(lostNhAttempt.state, SagaState.REMOTE_SUCCEEDED);

  const recovered = observeFinancialResult(beforeNhCommit, kbResult);
  assert.equal(recovered.state, SagaState.REMOTE_SUCCEEDED);
  assert.equal(buildFinancialCommand(recovered), null);
  assert.deepEqual(reconciliationPlan(recovered), { action: 'COMMIT_LOCAL_ONLY', operation_key: null });

  const completed = markLocalTransitionCommitted(recovered, 'ACTIVE');
  assert.equal(completed.state, SagaState.COMPLETED);
  assert.deepEqual(observeFinancialResult(completed, kbResult), completed);
});

test('duplicate callbacks are idempotent, accept NH-009 idempotency identity, and reject conflicts', () => {
  const saga = activationSaga();
  const command = buildFinancialCommand(saga);
  const result = successFor(command, 'escrow-1');
  const once = observeFinancialResult(saga, result);
  assert.deepEqual(observeFinancialResult(once, result), once);

  const idempotencyNamedDuplicate = {
    idempotency_key: command.idempotency_key,
    payload_digest: command.payload_digest,
    status: 'SUCCEEDED',
    result_ref: 'escrow-1',
  };
  assert.deepEqual(observeFinancialResult(once, idempotencyNamedDuplicate), once);

  assert.throws(
    () => observeFinancialResult(once, { ...result, result_ref: 'escrow-2' }),
    (error) => error.code === 'SAGA_RESULT_CONFLICT',
  );
  assert.throws(
    () => observeFinancialResult(saga, { ...result, payload_digest: digestSagaPayload({ different: true }) }),
    (error) => error.code === 'SAGA_IDEMPOTENCY_CONFLICT',
  );
});

test('confirmed activation escrow can be compensated exactly once through NH-005 REFUND', () => {
  const saga = activationSaga();
  const fund = buildFinancialCommand(saga);
  const funded = observeFinancialResult(saga, successFor(fund, 'escrow-1'));
  const compensating = requestActivationCompensation(funded, 'contract version became ineligible before ACTIVE commit');
  const refund = buildFinancialCommand(compensating);
  assert.deepEqual(buildFinancialCommand(compensating), refund);
  assert.equal(refund.operation, 'escrow');
  assert.equal(refund.payload.escrow_action, 'REFUND');
  assert.equal(refund.payload.escrow_ref, 'escrow-1');
  assert.equal(refund.payload.contract_ref, fund.payload.contract_ref);
  assert.equal(refund.payload.amount_micro_e, fund.payload.amount_micro_e);
  assert.equal(refund.correlation_id, fund.correlation_id);
  assert.notEqual(refund.idempotency_key, fund.idempotency_key);

  const refundAttempt = buildEconomyPortRequest(compensating, { requestId: 'refund-request-1' });
  assert.equal(assertEconomyPortRequest('escrow', refundAttempt), refundAttempt);
  assert.equal(refundAttempt.payload.escrow_action, 'REFUND');

  const compensated = observeFinancialResult(compensating, successFor(refund, 'refund-1'));
  assert.equal(compensated.state, SagaState.COMPENSATED);
  assert.equal(buildFinancialCommand(compensated), null);
  assert.deepEqual(observeFinancialResult(compensated, successFor(refund, 'refund-1')), compensated);
});

test('settlement is one NH-005 DISTRIBUTE operation and must converge forward after KB success', () => {
  const saga = settlementSaga();
  const command = buildFinancialCommand(saga);
  assert.equal(command.operation, 'escrow');
  assert.equal(command.payload.escrow_action, 'DISTRIBUTE');
  assert.equal(assertEconomyPortRequest('escrow', buildEconomyPortRequest(saga, { requestId: 'settle-request-1' })).operation, 'escrow');
  const result = successFor(command, 'settlement-journal-1');

  observeFinancialResult(saga, result);
  const recovered = observeFinancialResult(saga, result);
  assert.equal(recovered.state, SagaState.REMOTE_SUCCEEDED);
  assert.equal(buildFinancialCommand(recovered), null);

  assert.throws(
    () => requestActivationCompensation(recovered, 'do not claw back a completed settlement'),
    (error) => error.code === 'SETTLEMENT_COMPENSATION_FORBIDDEN',
  );

  const completed = markLocalTransitionCommitted(recovered, 'SETTLED');
  assert.equal(completed.state, SagaState.COMPLETED);
  assert.deepEqual(observeFinancialResult(completed, result), completed);
});

test('definite financial failure never advances the contract and requires a new validated saga', () => {
  const saga = activationSaga();
  const command = buildFinancialCommand(saga);
  const failed = observeFinancialResult(saga, {
    operation_key: command.operation_key,
    payload_digest: command.payload_digest,
    status: 'FAILED',
    error_code: 'INSUFFICIENT_ENERGY',
  });
  assert.equal(failed.state, SagaState.FAILED);
  assert.equal(buildFinancialCommand(failed), null);
  assert.deepEqual(reconciliationPlan(failed), { action: 'REVALIDATE_AND_CREATE_NEW_SAGA', operation_key: null });
  assert.throws(() => markLocalTransitionCommitted(failed, 'ACTIVE'), /cannot commit before confirmed remote financial success/);
});

test('all durable Saga intermediate states have an explicit recovery action', () => {
  const pending = activationSaga();
  const fund = buildFinancialCommand(pending);
  const funded = observeFinancialResult(pending, successFor(fund, 'escrow-1'));
  const compensating = requestActivationCompensation(funded, 'permanent activation invalidation');
  const refund = buildFinancialCommand(compensating);
  const manual = observeFinancialResult(compensating, {
    operation_key: refund.operation_key,
    payload_digest: refund.payload_digest,
    status: 'FAILED',
    error_code: 'CONFLICT',
  });
  const completed = markLocalTransitionCommitted(funded, 'ACTIVE');

  assert.equal(reconciliationPlan(pending).action, 'QUERY_PRIMARY_THEN_RETRY_SAME_KEY');
  assert.equal(reconciliationPlan(funded).action, 'COMMIT_LOCAL_ONLY');
  assert.equal(reconciliationPlan(compensating).action, 'QUERY_COMPENSATION_THEN_RETRY_SAME_KEY');
  assert.equal(reconciliationPlan(manual).action, 'MANUAL_RECONCILIATION');
  assert.equal(reconciliationPlan(completed).action, 'NONE');
});
