import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ECONOMY_PORT_EXAMPLES,
  ECONOMY_PORT_OPERATIONS,
  ECONOMY_PORT_SCENARIOS,
  ECONOMY_PORT_VERSION,
  assertEconomyPortRequest,
  assertEconomyPortResponse,
  assertMicroEString,
  createEconomyPort,
} from '../../src/ports/economy_port.js';

function adapterFromExamples() {
  return Object.fromEntries(
    ECONOMY_PORT_OPERATIONS.map((operation) => [operation, async () => ECONOMY_PORT_EXAMPLES[operation].normal.response]),
  );
}

test('NH-005 exposes exactly the minimum EconomyPort surface', () => {
  assert.deepEqual(ECONOMY_PORT_OPERATIONS, [
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
  assert.equal(ECONOMY_PORT_VERSION, 'nh.kb-economy-port.v1');
});

test('every EconomyPort operation has normal, duplicate, timeout, UNKNOWN, insufficient-balance and version-conflict vectors', () => {
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    assert.deepEqual(Object.keys(ECONOMY_PORT_EXAMPLES[operation]), ECONOMY_PORT_SCENARIOS);
    for (const scenario of ECONOMY_PORT_SCENARIOS) {
      const vector = ECONOMY_PORT_EXAMPLES[operation][scenario];
      assert.equal(assertEconomyPortRequest(operation, vector.request), vector.request, `${operation}/${scenario} request`);
      assert.equal(assertEconomyPortResponse(operation, vector.response), vector.response, `${operation}/${scenario} response`);
    }
  }
});

test('amounts are integer microE strings and never floating point JSON numbers', () => {
  assert.equal(assertMicroEString('1000000'), '1000000');
  assert.equal(assertMicroEString('-1000000', { allowNegative: true }), '-1000000');
  assert.throws(() => assertMicroEString(1000000), (error) => error.code === 'INVALID_MICRO_E');
  assert.throws(() => assertMicroEString('1.25'), (error) => error.code === 'INVALID_MICRO_E');
  const transfer = structuredClone(ECONOMY_PORT_EXAMPLES.transfer.normal.request);
  transfer.payload.amount_micro_e = 2;
  assert.throws(() => assertEconomyPortRequest('transfer', transfer), (error) => error.code === 'INVALID_MICRO_E');
});

test('timeout retry is same-idempotency-only while OUTCOME_UNKNOWN requires reconciliation', () => {
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    const timeout = ECONOMY_PORT_EXAMPLES[operation].timeout.response;
    assert.equal(timeout.status, 'TIMEOUT');
    assert.equal(timeout.error.retry_with_same_idempotency_key, true);
    const unknown = ECONOMY_PORT_EXAMPLES[operation].unknown.response;
    assert.equal(unknown.status, 'OUTCOME_UNKNOWN');
    assert.equal(unknown.error.retryable, false);
    assert.match(unknown.error.reconcile_ref, /^reconcile:/);
  }
});

test('duplicate vectors preserve the original authoritative operation reference', () => {
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    const normal = ECONOMY_PORT_EXAMPLES[operation].normal.response;
    const duplicate = ECONOMY_PORT_EXAMPLES[operation].duplicate.response;
    assert.equal(duplicate.status, 'DUPLICATE');
    assert.equal(duplicate.operation_ref, normal.operation_ref);
    assert.deepEqual(duplicate.result, normal.result);
  }
});

test('version conflict is explicit and carries the current provider version', () => {
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    const response = ECONOMY_PORT_EXAMPLES[operation].version_conflict.response;
    assert.equal(response.status, 'STALE_VERSION');
    assert.equal(response.error.code, 'STALE_VERSION');
    assert.match(response.error.current_version, /^\d+$/);
  }
});

test('KB Economy adapter is mandatory; there is no local ledger fallback', async () => {
  assert.throws(
    () => createEconomyPort(),
    (error) => error.code === 'UNAVAILABLE' && /local economy fallback is forbidden/.test(error.message),
  );
  assert.throws(
    () => createEconomyPort({ balance: async () => ({}) }),
    (error) => error.code === 'UNAVAILABLE',
  );

  const port = createEconomyPort(adapterFromExamples());
  const request = ECONOMY_PORT_EXAMPLES.balance.normal.request;
  const response = await port.balance(request);
  assert.deepEqual(response, ECONOMY_PORT_EXAMPLES.balance.normal.response);
});

test('the port uses opaque references only and does not expose KB table or wallet-row identifiers', () => {
  for (const operation of ECONOMY_PORT_OPERATIONS) {
    const request = ECONOMY_PORT_EXAMPLES[operation].normal.request;
    assert.equal('wallet_id' in request, false);
    assert.equal('account_id' in request, false);
    assert.equal('table' in request, false);
    assert.match(request.principal_ref, /^principal:/);
  }
});
