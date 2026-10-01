import { createHash } from 'node:crypto';

export const KB_IDEMPOTENCY_CONTRACT_VERSION = 'nh.kb-idempotency.v1';
export const KB_AUTHORITY = 'knowledge-ball';
export const DEFAULT_RETRY_BUDGET = 3;

const OPERATION_CLASSES = new Set(['READ', 'WRITE', 'FUNDS_WRITE']);
const LOOKUP_STATES = new Set(['NOT_CHECKED', 'FOUND', 'NOT_FOUND', 'UNAVAILABLE']);
const OUTCOMES = new Set(['SUCCESS', 'DEFINITIVE_FAILURE', 'RETRYABLE_FAILURE', 'OUTCOME_UNKNOWN']);

function contractError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requireString(value, name, maxLength = 200) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw contractError('INVALID_KB_IDEMPOTENCY_CONTEXT', `${name} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function canonicalizeJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw contractError('INVALID_KB_PAYLOAD', 'payload must contain finite JSON numbers only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw contractError('INVALID_KB_PAYLOAD', 'payload must contain plain JSON objects only');
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(',')}}`;
  }
  throw contractError('INVALID_KB_PAYLOAD', 'payload must be JSON-serializable without undefined, bigint, symbol, or function values');
}

export function payloadDigest(payload) {
  const canonical = canonicalizeJson(payload);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function buildCrossProductScope({ worldId, actorId, operation, idempotencyKey }) {
  const scope = {
    authority: KB_AUTHORITY,
    world_id: requireString(worldId, 'worldId'),
    actor_entity_id: requireString(actorId, 'actorId'),
    operation: requireString(operation, 'operation'),
    idempotency_key: requireString(idempotencyKey, 'idempotencyKey'),
  };
  return `${scope.authority}\u001f${scope.world_id}\u001f${scope.actor_entity_id}\u001f${scope.operation}\u001f${scope.idempotency_key}`;
}

export function buildKbAttempt({
  worldId,
  actorId,
  operation,
  operationClass = 'WRITE',
  originProduct,
  idempotencyKey,
  requestId,
  correlationId,
  payload,
  attemptNumber,
  retryBudget = DEFAULT_RETRY_BUDGET,
}) {
  if (!OPERATION_CLASSES.has(operationClass)) {
    throw contractError('INVALID_KB_IDEMPOTENCY_CONTEXT', `unsupported operationClass: ${operationClass}`);
  }
  if (originProduct !== 'newhumans' && originProduct !== 'knowledge-ball') {
    throw contractError('INVALID_KB_IDEMPOTENCY_CONTEXT', 'originProduct must be newhumans or knowledge-ball');
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw contractError('INVALID_KB_IDEMPOTENCY_CONTEXT', 'attemptNumber must be a positive integer');
  }
  if (!Number.isInteger(retryBudget) || retryBudget < 0) {
    throw contractError('INVALID_KB_IDEMPOTENCY_CONTEXT', 'retryBudget must be a non-negative integer');
  }

  const attempt = {
    contract_version: KB_IDEMPOTENCY_CONTRACT_VERSION,
    authority: KB_AUTHORITY,
    world_id: requireString(worldId, 'worldId'),
    actor_entity_id: requireString(actorId, 'actorId'),
    operation: requireString(operation, 'operation'),
    operation_class: operationClass,
    origin_product: originProduct,
    idempotency_key: requireString(idempotencyKey, 'idempotencyKey'),
    request_id: requireString(requestId, 'requestId'),
    correlation_id: requireString(correlationId, 'correlationId'),
    payload_digest: payloadDigest(payload),
    payload,
    attempt_number: attemptNumber,
    retry_budget: retryBudget,
  };

  attempt.scope_key = buildCrossProductScope({ worldId, actorId, operation, idempotencyKey });
  return attempt;
}

export function assertSameLogicalOperation(existing, incoming) {
  if (existing.scope_key !== incoming.scope_key) {
    throw contractError('IDEMPOTENCY_SCOPE_MISMATCH', 'retry changed the cross-product idempotency scope');
  }
  if (existing.correlation_id !== incoming.correlation_id) {
    throw contractError('CORRELATION_ID_CHANGED', 'correlation_id must remain stable for one logical operation');
  }
  if (existing.request_id === incoming.request_id) {
    throw contractError('REQUEST_ID_REUSED', 'request_id must be unique per transport attempt');
  }
  if (existing.payload_digest !== incoming.payload_digest) {
    throw contractError('IDEMPOTENCY_CONFLICT', 'same idempotency scope was reused with a different payload', 409);
  }
  return true;
}

export function assertDuplicatePayload(existingPayloadDigest, incomingPayload) {
  const incomingDigest = payloadDigest(incomingPayload);
  if (existingPayloadDigest !== incomingDigest) {
    throw contractError('IDEMPOTENCY_CONFLICT', 'same idempotency key was reused with a different payload', 409);
  }
  return incomingDigest;
}

export function totalAttemptLimit(retryBudget = DEFAULT_RETRY_BUDGET) {
  if (!Number.isInteger(retryBudget) || retryBudget < 0) {
    throw contractError('INVALID_RETRY_BUDGET', 'retryBudget must be a non-negative integer');
  }
  return retryBudget + 1;
}

export function decideRetry({
  attemptsMade,
  retryBudget = DEFAULT_RETRY_BUDGET,
  operationClass = 'WRITE',
  outcome,
  lookupState = 'NOT_CHECKED',
}) {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 0) {
    throw contractError('INVALID_RETRY_STATE', 'attemptsMade must be a non-negative integer');
  }
  if (!OPERATION_CLASSES.has(operationClass)) {
    throw contractError('INVALID_RETRY_STATE', `unsupported operationClass: ${operationClass}`);
  }
  if (!OUTCOMES.has(outcome)) throw contractError('INVALID_RETRY_STATE', `unsupported outcome: ${outcome}`);
  if (!LOOKUP_STATES.has(lookupState)) throw contractError('INVALID_RETRY_STATE', `unsupported lookupState: ${lookupState}`);

  if (lookupState === 'FOUND') return 'RETURN_STORED_RESULT';
  if (outcome === 'SUCCESS' || outcome === 'DEFINITIVE_FAILURE') return 'STOP';

  const budgetRemaining = attemptsMade < totalAttemptLimit(retryBudget);
  if (!budgetRemaining) return 'BUDGET_EXHAUSTED';

  if (outcome === 'OUTCOME_UNKNOWN') {
    if (lookupState === 'NOT_CHECKED' || lookupState === 'UNAVAILABLE') return 'QUERY_BY_IDEMPOTENCY_KEY';
    if (lookupState === 'NOT_FOUND') return 'RETRY_SAME_KEY';
  }

  if (outcome === 'RETRYABLE_FAILURE') return 'RETRY_SAME_KEY';
  return 'STOP';
}

export function assertFundsRetrySafe(state) {
  if (state.operationClass !== 'FUNDS_WRITE') return true;
  const decision = decideRetry(state);
  if (state.outcome === 'OUTCOME_UNKNOWN' && decision === 'RETRY_SAME_KEY' && state.lookupState !== 'NOT_FOUND') {
    throw contractError('UNSAFE_FUNDS_RETRY', 'funds writes may only retry after authoritative lookup confirms the operation is absent', 409);
  }
  return true;
}
