import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_BUDGET,
  assertDuplicatePayload,
  assertFundsRetrySafe,
  assertSameLogicalOperation,
  buildCrossProductScope,
  buildKbAttempt,
  decideRetry,
  payloadDigest,
  totalAttemptLimit,
} from '../../src/integrations/knowledge-ball/idempotency-retry.js';

const actor = '00000000-0000-4000-8000-000000000001';
const base = {
  worldId: 'world-1',
  actorId: actor,
  operation: 'economy.transfer',
  operationClass: 'FUNDS_WRITE',
  idempotencyKey: 'pay-order-123',
  correlationId: 'checkout-42',
  payload: { amount_micro_e: '1000000', payee: '00000000-0000-4000-8000-000000000002' },
};

class FakeKnowledgeBallAuthority {
  constructor() {
    this.records = new Map();
    this.fundsWrites = 0;
  }

  execute(attempt, { loseResponse = false } = {}) {
    const existing = this.records.get(attempt.scope_key);
    if (existing) {
      assertDuplicatePayload(existing.payload_digest, attempt.payload);
      return loseResponse ? undefined : structuredClone(existing.response);
    }
    this.fundsWrites += 1;
    const response = { status: 'SUCCEEDED', action_id: 'action-1', balance_delta_micro_e: '-1000000' };
    this.records.set(attempt.scope_key, {
      payload_digest: attempt.payload_digest,
      response,
    });
    return loseResponse ? undefined : structuredClone(response);
  }

  lookup(attempt) {
    const record = this.records.get(attempt.scope_key);
    return record ? structuredClone(record.response) : null;
  }
}

function attempt(overrides = {}) {
  return buildKbAttempt({
    ...base,
    originProduct: 'newhumans',
    requestId: 'request-1',
    attemptNumber: 1,
    ...overrides,
  });
}

test('cross-product scope excludes origin product, request id, and correlation id', () => {
  const nh = attempt();
  const kb = attempt({ originProduct: 'knowledge-ball', requestId: 'request-2' });
  assert.equal(nh.scope_key, kb.scope_key);
  assert.equal(nh.scope_key, buildCrossProductScope(base));
});

test('request id changes per transport attempt while correlation and idempotency identities stay stable', () => {
  const first = attempt();
  const second = attempt({ requestId: 'request-2', attemptNumber: 2, originProduct: 'knowledge-ball' });
  assert.equal(assertSameLogicalOperation(first, second), true);
  assert.throws(
    () => assertSameLogicalOperation(first, attempt({ requestId: 'request-1', attemptNumber: 2 })),
    (error) => error.code === 'REQUEST_ID_REUSED',
  );
  assert.throws(
    () => assertSameLogicalOperation(first, attempt({ requestId: 'request-2', correlationId: 'other-correlation', attemptNumber: 2 })),
    (error) => error.code === 'CORRELATION_ID_CHANGED',
  );
});

test('canonical payload digest is insensitive to object key order', () => {
  assert.equal(payloadDigest({ a: 1, b: { x: 2, y: 3 } }), payloadDigest({ b: { y: 3, x: 2 }, a: 1 }));
});

test('1000 duplicate funds requests execute the authoritative write exactly once across products', () => {
  const authority = new FakeKnowledgeBallAuthority();
  let firstResponse;
  for (let i = 1; i <= 1000; i += 1) {
    const current = attempt({
      originProduct: i % 2 === 0 ? 'knowledge-ball' : 'newhumans',
      requestId: `request-${i}`,
      attemptNumber: i,
    });
    const response = authority.execute(current);
    if (!firstResponse) firstResponse = response;
    assert.deepEqual(response, firstResponse);
  }
  assert.equal(authority.fundsWrites, 1);
});

test('same idempotency key with different payload conflicts before a second funds write', () => {
  const authority = new FakeKnowledgeBallAuthority();
  authority.execute(attempt());
  assert.throws(
    () => authority.execute(attempt({ requestId: 'request-2', payload: { ...base.payload, amount_micro_e: '2000000' } })),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
  assert.equal(authority.fundsWrites, 1);
});

test('lost response is reconciled by lookup and never blindly replays a funds write', () => {
  const authority = new FakeKnowledgeBallAuthority();
  const first = attempt();
  assert.equal(authority.execute(first, { loseResponse: true }), undefined);

  const stateBeforeLookup = {
    attemptsMade: 1,
    retryBudget: DEFAULT_RETRY_BUDGET,
    operationClass: 'FUNDS_WRITE',
    outcome: 'OUTCOME_UNKNOWN',
    lookupState: 'NOT_CHECKED',
  };
  assert.equal(decideRetry(stateBeforeLookup), 'QUERY_BY_IDEMPOTENCY_KEY');
  assert.equal(assertFundsRetrySafe(stateBeforeLookup), true);

  const stored = authority.lookup(first);
  assert.equal(stored.status, 'SUCCEEDED');
  assert.equal(decideRetry({ ...stateBeforeLookup, lookupState: 'FOUND' }), 'RETURN_STORED_RESULT');
  assert.equal(authority.fundsWrites, 1);
});

test('timeout then authoritative NOT_FOUND may retry only with the same logical key', () => {
  const first = attempt();
  const second = attempt({ requestId: 'request-2', attemptNumber: 2 });
  assert.equal(decideRetry({
    attemptsMade: 1,
    operationClass: 'FUNDS_WRITE',
    outcome: 'OUTCOME_UNKNOWN',
    lookupState: 'NOT_FOUND',
  }), 'RETRY_SAME_KEY');
  assert.equal(assertSameLogicalOperation(first, second), true);
  assert.equal(assertFundsRetrySafe({
    attemptsMade: 1,
    operationClass: 'FUNDS_WRITE',
    outcome: 'OUTCOME_UNKNOWN',
    lookupState: 'NOT_FOUND',
  }), true);
});

test('retry budget is end-to-end and cannot multiply across NewHumans and Knowledge Ball', () => {
  assert.equal(totalAttemptLimit(), 4);
  assert.equal(decideRetry({
    attemptsMade: 3,
    retryBudget: 3,
    operationClass: 'WRITE',
    outcome: 'RETRYABLE_FAILURE',
  }), 'RETRY_SAME_KEY');
  assert.equal(decideRetry({
    attemptsMade: 4,
    retryBudget: 3,
    operationClass: 'WRITE',
    outcome: 'RETRYABLE_FAILURE',
  }), 'BUDGET_EXHAUSTED');
});
