import { KB_ERROR_CODES, KB_ERROR_MODEL } from '../shared/kb_errors.js';

const CONTRACT_VERSION = 'nh.kb-economy-port.v1';

export const ECONOMY_PORT_VERSION = CONTRACT_VERSION;

export const ECONOMY_PORT_OPERATIONS = Object.freeze([
  'balance',
  'eligibility',
  'activity_day',
  'quote',
  'reserve',
  'release',
  'settle',
  'transfer',
  'escrow',
  'ledger',
]);

export const ECONOMY_PORT_STATUSES = Object.freeze([
  'SUCCEEDED',
  'DUPLICATE',
  ...KB_ERROR_CODES,
]);

export const ECONOMY_PORT_SCENARIOS = Object.freeze([
  'normal',
  'duplicate',
  'timeout',
  'unknown',
  'insufficient_balance',
  'version_conflict',
]);

const OPERATION_SET = new Set(ECONOMY_PORT_OPERATIONS);
const STATUS_SET = new Set(ECONOMY_PORT_STATUSES);
const PURPOSES = new Set(['ACTIVITY', 'TASK_SEEK', 'INBOUND_OFFER', 'CONTRACT_EXECUTION']);
const ESCROW_ACTIONS = new Set(['FUND', 'DISTRIBUTE', 'REFUND']);
const DECIMAL_INTEGER = /^-?(0|[1-9]\d*)$/;
const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function contractError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('INVALID_ECONOMY_PORT_ENVELOPE', `${field} must be an object`, { field });
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw contractError('INVALID_ECONOMY_PORT_ENVELOPE', `${field} must be a non-empty string`, { field });
  }
}

function assertVersion(value, field) {
  if (value !== undefined && (typeof value !== 'string' || !NON_NEGATIVE_INTEGER.test(value))) {
    throw contractError('INVALID_ECONOMY_PORT_ENVELOPE', `${field} must be a non-negative decimal integer string`, { field });
  }
}

export function assertMicroEString(value, { field = 'amount_micro_e', allowNegative = false, allowZero = true } = {}) {
  const pattern = allowNegative ? DECIMAL_INTEGER : allowZero ? NON_NEGATIVE_INTEGER : POSITIVE_INTEGER;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw contractError(
      'INVALID_MICRO_E',
      `${field} must be a ${allowNegative ? 'signed ' : ''}decimal integer string in microE`,
      { field },
    );
  }
  return value;
}

function walkMicroE(value, path = 'envelope') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) walkMicroE(value[index], `${path}[${index}]`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key.endsWith('_micro_e')) assertMicroEString(child, { field: childPath, allowNegative: true });
    else walkMicroE(child, childPath);
  }
}

function assertPositiveMicroE(payload, field) {
  if (payload[field] !== undefined) assertMicroEString(payload[field], { field: `payload.${field}`, allowZero: false });
}

function assertRequestPayload(operation, payload) {
  switch (operation) {
    case 'balance':
      break;
    case 'eligibility':
      if (!PURPOSES.has(payload.purpose)) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.purpose is not supported', { operation, field: 'payload.purpose' });
      }
      break;
    case 'activity_day':
      if (typeof payload.billing_date !== 'string' || !ISO_DATE.test(payload.billing_date)) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.billing_date must be YYYY-MM-DD', { operation, field: 'payload.billing_date' });
      }
      break;
    case 'quote':
      assertNonEmptyString(payload.scope_ref, 'payload.scope_ref');
      if (payload.max_cost_micro_e !== undefined) assertPositiveMicroE(payload, 'max_cost_micro_e');
      break;
    case 'reserve':
      assertNonEmptyString(payload.quote_ref, 'payload.quote_ref');
      assertPositiveMicroE(payload, 'amount_micro_e');
      if (payload.amount_micro_e === undefined) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.amount_micro_e is required', { operation });
      }
      break;
    case 'release':
      assertNonEmptyString(payload.reservation_ref, 'payload.reservation_ref');
      if (payload.amount_micro_e !== undefined) assertPositiveMicroE(payload, 'amount_micro_e');
      break;
    case 'settle':
      assertNonEmptyString(payload.reservation_ref, 'payload.reservation_ref');
      assertNonEmptyString(payload.receipt_ref, 'payload.receipt_ref');
      assertPositiveMicroE(payload, 'actual_cost_micro_e');
      if (payload.actual_cost_micro_e === undefined) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.actual_cost_micro_e is required', { operation });
      }
      break;
    case 'transfer':
      assertNonEmptyString(payload.to_principal_ref, 'payload.to_principal_ref');
      assertPositiveMicroE(payload, 'amount_micro_e');
      if (payload.amount_micro_e === undefined) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.amount_micro_e is required', { operation });
      }
      break;
    case 'escrow':
      if (!ESCROW_ACTIONS.has(payload.escrow_action)) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.escrow_action is not supported', { operation, field: 'payload.escrow_action' });
      }
      assertNonEmptyString(payload.contract_ref, 'payload.contract_ref');
      assertPositiveMicroE(payload, 'amount_micro_e');
      if (payload.amount_micro_e === undefined) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.amount_micro_e is required', { operation });
      }
      break;
    case 'ledger':
      if (payload.limit !== undefined && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 500)) {
        throw contractError('INVALID_ECONOMY_PORT_REQUEST', 'payload.limit must be an integer from 1 to 500', { operation, field: 'payload.limit' });
      }
      if (payload.cursor !== undefined) assertNonEmptyString(payload.cursor, 'payload.cursor');
      break;
    default:
      throw contractError('UNKNOWN_ECONOMY_PORT_OPERATION', `unknown economy operation: ${operation}`, { operation });
  }
}

export function assertEconomyPortRequest(operation, request) {
  if (!OPERATION_SET.has(operation)) {
    throw contractError('UNKNOWN_ECONOMY_PORT_OPERATION', `unknown economy operation: ${operation}`, { operation });
  }
  assertPlainObject(request, 'request');
  if (request.contract_version !== CONTRACT_VERSION) {
    throw contractError('ECONOMY_PORT_VERSION_MISMATCH', `contract_version must equal ${CONTRACT_VERSION}`, { operation });
  }
  if (request.operation !== operation) {
    throw contractError('INVALID_ECONOMY_PORT_ENVELOPE', `request.operation must equal ${operation}`, { operation });
  }
  assertNonEmptyString(request.request_id, 'request.request_id');
  assertNonEmptyString(request.idempotency_key, 'request.idempotency_key');
  assertNonEmptyString(request.principal_ref, 'request.principal_ref');
  assertVersion(request.expected_version, 'request.expected_version');
  assertPlainObject(request.payload, 'request.payload');
  walkMicroE(request.payload, 'request.payload');
  assertRequestPayload(operation, request.payload);
  return request;
}

export function assertEconomyPortResponse(operation, response) {
  if (!OPERATION_SET.has(operation)) {
    throw contractError('UNKNOWN_ECONOMY_PORT_OPERATION', `unknown economy operation: ${operation}`, { operation });
  }
  assertPlainObject(response, 'response');
  if (response.contract_version !== CONTRACT_VERSION) {
    throw contractError('ECONOMY_PORT_VERSION_MISMATCH', `contract_version must equal ${CONTRACT_VERSION}`, { operation });
  }
  if (response.operation !== operation) {
    throw contractError('INVALID_ECONOMY_PORT_ENVELOPE', `response.operation must equal ${operation}`, { operation });
  }
  assertNonEmptyString(response.request_id, 'response.request_id');
  if (!STATUS_SET.has(response.status)) {
    throw contractError('INVALID_ECONOMY_PORT_RESPONSE', 'response.status is not supported', { operation, status: response.status });
  }
  assertVersion(response.resource_version, 'response.resource_version');
  if (response.operation_ref !== undefined) assertNonEmptyString(response.operation_ref, 'response.operation_ref');
  if (response.result !== null && response.result !== undefined) assertPlainObject(response.result, 'response.result');
  if (response.error !== null && response.error !== undefined) assertPlainObject(response.error, 'response.error');
  walkMicroE(response, 'response');

  if (response.status === 'SUCCEEDED' || response.status === 'DUPLICATE') {
    if (response.error !== null) {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', `${response.status} must have error=null`, { operation });
    }
    if (response.result === null || response.result === undefined) {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', `${response.status} must include result`, { operation });
    }
  } else {
    if (!KB_ERROR_MODEL[response.status] || response.error?.code !== response.status) {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', 'error status must use the canonical KB error code', { operation, status: response.status });
    }
    if (response.result !== null) {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', `${response.status} must have result=null`, { operation });
    }
    if (response.error === null || response.error === undefined) {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', `${response.status} must include error`, { operation });
    }
  }

  if (response.status === 'DUPLICATE') {
    assertNonEmptyString(response.operation_ref, 'response.operation_ref');
  }
  if (response.status === 'TIMEOUT') {
    if (response.error.code !== 'TIMEOUT' || response.error.retry_with_same_idempotency_key !== true) {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', 'TIMEOUT must require retry with the same idempotency key', { operation });
    }
  }
  if (response.status === 'OUTCOME_UNKNOWN') {
    if (response.error.code !== 'OUTCOME_UNKNOWN') {
      throw contractError('INVALID_ECONOMY_PORT_RESPONSE', 'OUTCOME_UNKNOWN must use error.code OUTCOME_UNKNOWN', { operation });
    }
    assertNonEmptyString(response.error.reconcile_ref, 'response.error.reconcile_ref');
  }
  if (response.status === 'INSUFFICIENT_ENERGY') {
    assertMicroEString(response.error.available_micro_e, { field: 'response.error.available_micro_e' });
    assertMicroEString(response.error.required_micro_e, { field: 'response.error.required_micro_e' });
  }
  if (response.status === 'STALE_VERSION') {
    assertVersion(response.error.current_version, 'response.error.current_version');
  }
  return response;
}

function dependencyUnavailable(message, details = {}) {
  return contractError('UNAVAILABLE', message, { kb_error: KB_ERROR_MODEL.UNAVAILABLE, ...details });
}

export function createEconomyPort(adapter) {
  if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw dependencyUnavailable('KB Economy adapter is required; local economy fallback is forbidden');
  }
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    if (typeof adapter[operation] !== 'function') {
      throw dependencyUnavailable(`KB Economy adapter is missing operation ${operation}`, { operation });
    }
  }
  const port = {};
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    port[operation] = async (request) => {
      assertEconomyPortRequest(operation, request);
      const response = await adapter[operation](request);
      return assertEconomyPortResponse(operation, response);
    };
  }
  return Object.freeze(port);
}

function requestFor(operation, payload) {
  return {
    contract_version: CONTRACT_VERSION,
    operation,
    request_id: `request-${operation}`,
    idempotency_key: `idem-${operation}`,
    principal_ref: 'principal:agent-1',
    expected_version: '7',
    payload,
  };
}

function successResponse(operation, result) {
  return {
    contract_version: CONTRACT_VERSION,
    operation,
    request_id: `request-${operation}`,
    status: 'SUCCEEDED',
    operation_ref: `op:${operation}:1`,
    resource_version: '8',
    result,
    error: null,
  };
}

function duplicateResponse(operation, result) {
  return {
    ...successResponse(operation, result),
    status: 'DUPLICATE',
  };
}

function errorResponse(operation, status, error) {
  return {
    contract_version: CONTRACT_VERSION,
    operation,
    request_id: `request-${operation}`,
    status,
    operation_ref: `op:${operation}:1`,
    resource_version: '8',
    result: null,
    error,
  };
}

const SAMPLE_DEFINITIONS = {
  balance: {
    payload: {},
    result: { posted_micro_e: '120000000', reserved_micro_e: '10000000', frozen_micro_e: '0', available_micro_e: '110000000' },
    insufficient: { posted_micro_e: '500000', reserved_micro_e: '0', frozen_micro_e: '0', available_micro_e: '500000', balance_condition: 'INSUFFICIENT_BALANCE' },
  },
  eligibility: {
    payload: { purpose: 'TASK_SEEK' },
    result: { eligible: true, reason_code: 'ELIGIBLE', available_micro_e: '110000000', activity_day_status: 'PAID' },
    insufficient: { eligible: false, reason_code: 'INSUFFICIENT_BALANCE', available_micro_e: '500000', activity_day_status: 'PAID' },
  },
  activity_day: {
    payload: { billing_date: '2026-10-01' },
    result: { billing_date: '2026-10-01', charged: true, fee_micro_e: '1000000', activity_day_ref: 'activity-day:2026-10-01' },
  },
  quote: {
    payload: { scope_ref: 'scope:model-call-1', max_cost_micro_e: '5000000' },
    result: { quote_ref: 'quote:1', max_cost_micro_e: '5000000', expires_at: '2026-10-01T15:00:00Z', fundable: true },
    insufficient: { quote_ref: 'quote:1', max_cost_micro_e: '5000000', expires_at: '2026-10-01T15:00:00Z', fundable: false, available_micro_e: '500000' },
  },
  reserve: {
    payload: { quote_ref: 'quote:1', amount_micro_e: '5000000' },
    result: { reservation_ref: 'reservation:1', reserved_micro_e: '5000000', available_micro_e: '105000000' },
  },
  release: {
    payload: { reservation_ref: 'reservation:1', amount_micro_e: '1000000' },
    result: { reservation_ref: 'reservation:1', released_micro_e: '1000000', remaining_reserved_micro_e: '4000000' },
    insufficient: { reservation_ref: 'reservation:1', released_micro_e: '1000000', remaining_reserved_micro_e: '4000000', pre_release_balance_condition: 'INSUFFICIENT_BALANCE' },
  },
  settle: {
    payload: { reservation_ref: 'reservation:1', actual_cost_micro_e: '3200000', receipt_ref: 'receipt:1' },
    result: { reservation_ref: 'reservation:1', settled_micro_e: '3200000', released_micro_e: '1800000' },
  },
  transfer: {
    payload: { to_principal_ref: 'principal:agent-2', amount_micro_e: '2000000' },
    result: { transfer_ref: 'transfer:1', amount_micro_e: '2000000' },
  },
  escrow: {
    payload: { escrow_action: 'FUND', contract_ref: 'contract:1', amount_micro_e: '20000000' },
    result: { escrow_ref: 'escrow:1', escrow_action: 'FUND', amount_micro_e: '20000000' },
  },
  ledger: {
    payload: { limit: 50 },
    result: { entries: [{ entry_ref: 'entry:1', amount_micro_e: '-1000000', occurred_at: '2026-10-01T00:00:05Z', operation_ref: 'op:activity_day:1' }], next_cursor: null, available_micro_e: '110000000' },
    insufficient: { entries: [], next_cursor: null, available_micro_e: '500000', balance_condition: 'INSUFFICIENT_BALANCE' },
  },
};

function insufficientExample(operation, definition) {
  if (definition.insufficient) return successResponse(operation, definition.insufficient);
  return errorResponse(operation, 'INSUFFICIENT_ENERGY', {
    code: 'INSUFFICIENT_ENERGY',
    retryable: false,
    available_micro_e: '500000',
    required_micro_e: '1000000',
  });
}

export const ECONOMY_PORT_EXAMPLES = Object.freeze(Object.fromEntries(
  ECONOMY_PORT_OPERATIONS.map((operation) => {
    const definition = SAMPLE_DEFINITIONS[operation];
    const request = requestFor(operation, definition.payload);
    const scenarios = {
      normal: { request, response: successResponse(operation, definition.result) },
      duplicate: { request, response: duplicateResponse(operation, definition.result) },
      timeout: {
        request,
        response: errorResponse(operation, 'TIMEOUT', {
          code: 'TIMEOUT',
          retryable: true,
          retry_with_same_idempotency_key: true,
        }),
      },
      unknown: {
        request,
        response: errorResponse(operation, 'OUTCOME_UNKNOWN', {
          code: 'OUTCOME_UNKNOWN',
          retryable: false,
          reconcile_ref: `reconcile:${operation}:1`,
        }),
      },
      insufficient_balance: { request, response: insufficientExample(operation, definition) },
      version_conflict: {
        request,
        response: errorResponse(operation, 'STALE_VERSION', {
          code: 'STALE_VERSION',
          retryable: true,
          current_version: '9',
        }),
      },
    };
    return [operation, Object.freeze(scenarios)];
  }),
));
