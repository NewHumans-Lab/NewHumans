import {
  KB_IDEMPOTENCY_CONTRACT_VERSION,
  payloadDigest,
} from '../integrations/knowledge-ball/idempotency-retry.js';
import {
  ECONOMY_PORT_VERSION,
  assertEconomyPortRequest,
} from '../ports/economy_port.js';

export const SagaKind = Object.freeze({
  CONTRACT_ACTIVATION: 'CONTRACT_ACTIVATION',
  CONTRACT_SETTLEMENT: 'CONTRACT_SETTLEMENT',
});

export const SagaState = Object.freeze({
  PENDING_REMOTE: 'PENDING_REMOTE',
  REMOTE_SUCCEEDED: 'REMOTE_SUCCEEDED',
  FAILED: 'FAILED',
  COMPLETED: 'COMPLETED',
  COMPENSATION_PENDING: 'COMPENSATION_PENDING',
  COMPENSATED: 'COMPENSATED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
});

export const SagaStep = Object.freeze({
  FUND_ESCROW: 'FUND_ESCROW',
  DISTRIBUTE_ESCROW: 'DISTRIBUTE_ESCROW',
  RELEASE_ESCROW: 'RELEASE_ESCROW',
});

const PRIMARY_STEP = Object.freeze({
  [SagaKind.CONTRACT_ACTIVATION]: SagaStep.FUND_ESCROW,
  [SagaKind.CONTRACT_SETTLEMENT]: SagaStep.DISTRIBUTE_ESCROW,
});

const ECONOMY_ESCROW_ACTION = Object.freeze({
  [SagaStep.FUND_ESCROW]: 'FUND',
  [SagaStep.DISTRIBUTE_ESCROW]: 'DISTRIBUTE',
  [SagaStep.RELEASE_ESCROW]: 'REFUND',
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_SAGA_INPUT', `${name} must be a non-empty string`);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    fail('INVALID_SAGA_INPUT', 'contractVersion must be a positive integer');
  }
  return value;
}

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SAGA_INPUT', `${name} must be an object`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

// Delegate payload identity to the normative NH-009 cross-product idempotency contract.
export function digestSagaPayload(value) {
  return payloadDigest(value);
}

export function sagaOperationKey({ worldId, businessAttemptId, step }) {
  nonEmpty(worldId, 'worldId');
  nonEmpty(businessAttemptId, 'businessAttemptId');
  nonEmpty(step, 'step');
  return `nh-saga/v1/${encodeURIComponent(worldId)}/${encodeURIComponent(businessAttemptId)}/${step}`;
}

function clone(value) {
  // NH-009 validates the original value before cloning so unsupported JSON values
  // cannot disappear silently and later acquire a different digest.
  digestSagaPayload(value);
  return JSON.parse(JSON.stringify(value));
}

function economyPortPayload(step, payload) {
  const action = ECONOMY_ESCROW_ACTION[step];
  if (!action) fail('INVALID_SAGA_INPUT', `unsupported saga step ${step}`);
  plainObject(payload, 'request.payload');
  if (payload.escrow_action !== undefined && payload.escrow_action !== action) {
    fail('INVALID_SAGA_INPUT', `request.payload.escrow_action must equal ${action}`);
  }
  return { ...clone(payload), escrow_action: action };
}

function canonicalFinancialRequest(step, request) {
  plainObject(request, 'request');
  nonEmpty(request.principal_ref, 'request.principal_ref');
  const normalized = {
    principal_ref: request.principal_ref,
    payload: economyPortPayload(step, request.payload),
  };

  // Validate the durable business snapshot against the authoritative NH-005
  // EconomyPort shape without creating a real transport attempt.
  assertEconomyPortRequest('escrow', {
    contract_version: ECONOMY_PORT_VERSION,
    operation: 'escrow',
    request_id: 'saga-shape-validation',
    idempotency_key: 'saga-shape-validation',
    principal_ref: normalized.principal_ref,
    payload: normalized.payload,
  });
  return normalized;
}

function digestFinancialRequest(request) {
  return digestSagaPayload({
    principal_ref: request.principal_ref,
    payload: request.payload,
  });
}

function createSaga({ kind, sagaId, worldId, contractId, contractVersion, businessAttemptId, request }) {
  if (!Object.values(SagaKind).includes(kind)) fail('INVALID_SAGA_INPUT', 'unsupported saga kind');
  nonEmpty(sagaId, 'sagaId');
  nonEmpty(worldId, 'worldId');
  nonEmpty(contractId, 'contractId');
  nonEmpty(businessAttemptId, 'businessAttemptId');
  positiveVersion(contractVersion);

  const primaryStep = PRIMARY_STEP[kind];
  const primaryRequest = canonicalFinancialRequest(primaryStep, request);
  return {
    protocol_version: 'nh.cross_product_saga.v1',
    kind,
    saga_id: sagaId,
    business_attempt_id: businessAttemptId,
    world_id: worldId,
    contract_id: contractId,
    contract_version: contractVersion,
    state: SagaState.PENDING_REMOTE,
    primary_step: primaryStep,
    primary_operation_key: sagaOperationKey({ worldId, businessAttemptId, step: primaryStep }),
    primary_payload_digest: digestFinancialRequest(primaryRequest),
    primary_request: primaryRequest,
    primary_result: null,
    compensation_operation_key: null,
    compensation_payload_digest: null,
    compensation_request: null,
    compensation_result: null,
    compensation_reason: null,
  };
}

export function createContractActivationSaga(input) {
  return createSaga({
    kind: SagaKind.CONTRACT_ACTIVATION,
    sagaId: input.sagaId,
    worldId: input.worldId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    businessAttemptId: input.businessAttemptId,
    request: input.escrowRequest,
  });
}

export function createContractSettlementSaga(input) {
  return createSaga({
    kind: SagaKind.CONTRACT_SETTLEMENT,
    sagaId: input.sagaId,
    worldId: input.worldId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    businessAttemptId: input.businessAttemptId,
    request: input.settlementRequest,
  });
}

function expectedFinancialIntent(operationKey, correlationId, step, request) {
  return {
    protocol_version: 'nh.cross_product_saga.v1',
    economy_port_contract_version: ECONOMY_PORT_VERSION,
    kb_idempotency_contract_version: KB_IDEMPOTENCY_CONTRACT_VERSION,
    capability: 'economy',
    operation_class: 'FUNDS_WRITE',
    operation: 'escrow',
    saga_step: step,
    operation_key: operationKey,
    idempotency_key: operationKey,
    correlation_id: correlationId,
    principal_ref: request.principal_ref,
    payload_digest: digestFinancialRequest(request),
    payload: clone(request.payload),
  };
}

// This is a durable logical financial intent, not a transport attempt. NH-005
// supplies the actual EconomyPort envelope; NH-009 supplies cross-product retry
// identity. A resend changes only transport-attempt metadata such as request_id.
export function buildFinancialCommand(saga) {
  assertSagaInvariant(saga);
  if (saga.state === SagaState.PENDING_REMOTE) {
    return expectedFinancialIntent(
      saga.primary_operation_key,
      saga.business_attempt_id,
      saga.primary_step,
      saga.primary_request,
    );
  }
  if (saga.state === SagaState.COMPENSATION_PENDING) {
    return expectedFinancialIntent(
      saga.compensation_operation_key,
      saga.business_attempt_id,
      SagaStep.RELEASE_ESCROW,
      saga.compensation_request,
    );
  }
  return null;
}

export function buildEconomyPortRequest(saga, { requestId, expectedVersion } = {}) {
  nonEmpty(requestId, 'requestId');
  const command = buildFinancialCommand(saga);
  if (!command) return null;
  const request = {
    contract_version: ECONOMY_PORT_VERSION,
    operation: 'escrow',
    request_id: requestId,
    idempotency_key: command.idempotency_key,
    principal_ref: command.principal_ref,
    ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }),
    payload: clone(command.payload),
  };
  assertEconomyPortRequest('escrow', request);
  return request;
}

function resultIdentity(result) {
  if (!result || typeof result !== 'object') fail('INVALID_SAGA_RESULT', 'result must be an object');
  const operationKey = result.operation_key ?? result.idempotency_key;
  nonEmpty(operationKey, 'result.operation_key or result.idempotency_key');
  nonEmpty(result.payload_digest, 'result.payload_digest');
  if (!['SUCCEEDED', 'FAILED'].includes(result.status)) {
    fail('INVALID_SAGA_RESULT', 'result.status must be SUCCEEDED or FAILED');
  }
  if (result.status === 'SUCCEEDED') nonEmpty(result.result_ref, 'result.result_ref');
  return {
    operation_key: operationKey,
    payload_digest: result.payload_digest,
    status: result.status,
    result_ref: result.result_ref ?? null,
    error_code: result.error_code ?? null,
  };
}

function sameResult(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function observePrimary(saga, result) {
  if (result.payload_digest !== saga.primary_payload_digest) {
    fail('SAGA_IDEMPOTENCY_CONFLICT', 'primary operation key was reused with a different payload digest');
  }
  if (saga.primary_result) {
    if (!sameResult(saga.primary_result, result)) {
      fail('SAGA_RESULT_CONFLICT', 'primary operation produced conflicting durable results');
    }
    return saga;
  }
  if (saga.state !== SagaState.PENDING_REMOTE) {
    fail('INVALID_SAGA_TRANSITION', `cannot record a new primary result from ${saga.state}`);
  }
  return {
    ...saga,
    state: result.status === 'SUCCEEDED' ? SagaState.REMOTE_SUCCEEDED : SagaState.FAILED,
    primary_result: result,
  };
}

function observeCompensation(saga, result) {
  if (!saga.compensation_operation_key || result.payload_digest !== saga.compensation_payload_digest) {
    fail('SAGA_IDEMPOTENCY_CONFLICT', 'compensation operation key was reused with a different payload digest');
  }
  if (saga.compensation_result) {
    if (!sameResult(saga.compensation_result, result)) {
      fail('SAGA_RESULT_CONFLICT', 'compensation operation produced conflicting durable results');
    }
    return saga;
  }
  if (saga.state !== SagaState.COMPENSATION_PENDING) {
    fail('INVALID_SAGA_TRANSITION', `cannot record compensation result from ${saga.state}`);
  }
  return {
    ...saga,
    state: result.status === 'SUCCEEDED' ? SagaState.COMPENSATED : SagaState.RECONCILIATION_REQUIRED,
    compensation_result: result,
  };
}

export function observeFinancialResult(saga, rawResult) {
  assertSagaInvariant(saga);
  const result = resultIdentity(rawResult);
  if (result.operation_key === saga.primary_operation_key) return observePrimary(saga, result);
  if (result.operation_key === saga.compensation_operation_key) return observeCompensation(saga, result);
  fail('UNEXPECTED_SAGA_OPERATION', 'financial result does not belong to this saga');
}

export function markLocalTransitionCommitted(saga, localContractState) {
  assertSagaInvariant(saga);
  if (saga.state !== SagaState.REMOTE_SUCCEEDED || saga.primary_result?.status !== 'SUCCEEDED') {
    fail('INVALID_SAGA_TRANSITION', 'local business state cannot commit before confirmed remote financial success');
  }
  const expected = saga.kind === SagaKind.CONTRACT_ACTIVATION ? 'ACTIVE' : 'SETTLED';
  if (localContractState !== expected) {
    fail('INVALID_SAGA_TRANSITION', `expected local contract state ${expected}`);
  }
  return { ...saga, state: SagaState.COMPLETED };
}

export function requestActivationCompensation(saga, reason) {
  assertSagaInvariant(saga);
  if (saga.kind !== SagaKind.CONTRACT_ACTIVATION) {
    fail('SETTLEMENT_COMPENSATION_FORBIDDEN', 'a completed KB settlement must converge forward; it cannot be auto-reversed');
  }
  if (saga.state !== SagaState.REMOTE_SUCCEEDED || saga.primary_result?.status !== 'SUCCEEDED') {
    fail('INVALID_SAGA_TRANSITION', 'escrow refund is allowed only after confirmed activation escrow success');
  }
  nonEmpty(reason, 'reason');
  const compensationRequest = canonicalFinancialRequest(SagaStep.RELEASE_ESCROW, {
    principal_ref: saga.primary_request.principal_ref,
    payload: {
      contract_ref: saga.primary_request.payload.contract_ref,
      amount_micro_e: saga.primary_request.payload.amount_micro_e,
      escrow_ref: saga.primary_result.result_ref,
      reason,
    },
  });
  return {
    ...saga,
    state: SagaState.COMPENSATION_PENDING,
    compensation_operation_key: sagaOperationKey({
      worldId: saga.world_id,
      businessAttemptId: saga.business_attempt_id,
      step: SagaStep.RELEASE_ESCROW,
    }),
    compensation_payload_digest: digestFinancialRequest(compensationRequest),
    compensation_request: compensationRequest,
    compensation_reason: reason,
  };
}

export function reconciliationPlan(saga) {
  assertSagaInvariant(saga);
  switch (saga.state) {
    case SagaState.PENDING_REMOTE:
      return Object.freeze({ action: 'QUERY_PRIMARY_THEN_RETRY_SAME_KEY', operation_key: saga.primary_operation_key });
    case SagaState.REMOTE_SUCCEEDED:
      return Object.freeze({ action: 'COMMIT_LOCAL_ONLY', operation_key: null });
    case SagaState.FAILED:
      return Object.freeze({ action: 'REVALIDATE_AND_CREATE_NEW_SAGA', operation_key: null });
    case SagaState.COMPENSATION_PENDING:
      return Object.freeze({ action: 'QUERY_COMPENSATION_THEN_RETRY_SAME_KEY', operation_key: saga.compensation_operation_key });
    case SagaState.RECONCILIATION_REQUIRED:
      return Object.freeze({ action: 'MANUAL_RECONCILIATION', operation_key: saga.compensation_operation_key });
    case SagaState.COMPLETED:
    case SagaState.COMPENSATED:
      return Object.freeze({ action: 'NONE', operation_key: null });
    default:
      fail('INVALID_SAGA_STATE', `unknown saga state ${saga.state}`);
  }
}

export function assertSagaInvariant(saga) {
  if (!saga || typeof saga !== 'object') fail('INVALID_SAGA', 'saga must be an object');
  if (!Object.values(SagaKind).includes(saga.kind)) fail('INVALID_SAGA', 'unknown saga kind');
  if (!Object.values(SagaState).includes(saga.state)) fail('INVALID_SAGA', 'unknown saga state');
  nonEmpty(saga.business_attempt_id, 'saga.business_attempt_id');
  const expectedPrimaryStep = PRIMARY_STEP[saga.kind];
  if (saga.primary_step !== expectedPrimaryStep) fail('INVALID_SAGA', 'primary step does not match saga kind');
  const expectedKey = sagaOperationKey({
    worldId: saga.world_id,
    businessAttemptId: saga.business_attempt_id,
    step: expectedPrimaryStep,
  });
  if (saga.primary_operation_key !== expectedKey) fail('INVALID_SAGA', 'primary operation key is not deterministic');
  const normalizedPrimary = canonicalFinancialRequest(expectedPrimaryStep, saga.primary_request);
  if (canonicalJson(normalizedPrimary) !== canonicalJson(saga.primary_request)) {
    fail('INVALID_SAGA', 'primary request does not match the NH-005 escrow shape');
  }
  if (digestFinancialRequest(saga.primary_request) !== saga.primary_payload_digest) {
    fail('INVALID_SAGA', 'primary payload digest does not match request');
  }
  if ([SagaState.REMOTE_SUCCEEDED, SagaState.COMPLETED, SagaState.COMPENSATION_PENDING, SagaState.COMPENSATED, SagaState.RECONCILIATION_REQUIRED].includes(saga.state)) {
    if (saga.primary_result?.status !== 'SUCCEEDED') fail('INVALID_SAGA', 'state requires confirmed primary financial success');
  }
  if (saga.state === SagaState.FAILED && saga.primary_result?.status !== 'FAILED') {
    fail('INVALID_SAGA', 'FAILED state requires a definite primary financial failure');
  }
  if ([SagaState.COMPENSATION_PENDING, SagaState.COMPENSATED, SagaState.RECONCILIATION_REQUIRED].includes(saga.state)) {
    if (saga.kind !== SagaKind.CONTRACT_ACTIVATION) fail('INVALID_SAGA', 'only activation may compensate escrow funding');
    const expectedCompensationKey = sagaOperationKey({
      worldId: saga.world_id,
      businessAttemptId: saga.business_attempt_id,
      step: SagaStep.RELEASE_ESCROW,
    });
    if (saga.compensation_operation_key !== expectedCompensationKey) {
      fail('INVALID_SAGA', 'compensation operation key is not deterministic');
    }
    const normalizedCompensation = canonicalFinancialRequest(SagaStep.RELEASE_ESCROW, saga.compensation_request);
    if (canonicalJson(normalizedCompensation) !== canonicalJson(saga.compensation_request)) {
      fail('INVALID_SAGA', 'compensation request does not match the NH-005 escrow shape');
    }
    if (digestFinancialRequest(saga.compensation_request) !== saga.compensation_payload_digest) {
      fail('INVALID_SAGA', 'compensation payload digest does not match request');
    }
  }
  if (saga.state === SagaState.COMPENSATED && saga.compensation_result?.status !== 'SUCCEEDED') {
    fail('INVALID_SAGA', 'COMPENSATED state requires confirmed escrow refund');
  }
  if (saga.state === SagaState.COMPLETED && saga.kind === SagaKind.CONTRACT_SETTLEMENT && saga.compensation_operation_key) {
    fail('INVALID_SAGA', 'settlement cannot have a compensation operation');
  }
  return saga;
}
