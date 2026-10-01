import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KB_ERROR_CODES,
  KB_ERROR_DISPOSITION,
  KB_ERROR_MODEL,
  getKbErrorDefinition,
  isRetryableKbError,
  requiresKbErrorReconciliation,
} from '../../src/shared/kb_errors.js';

const EXPECTED_DISPOSITIONS = Object.freeze({
  UNAVAILABLE: 'retryable',
  TIMEOUT: 'retryable',
  AUTH_FAILED: 'non-retryable',
  BINDING_MISSING: 'non-retryable',
  STALE_VERSION: 'retryable',
  INSUFFICIENT_ENERGY: 'non-retryable',
  CONFLICT: 'non-retryable',
  OUTCOME_UNKNOWN: 'reconciliation-required',
});

test('KB error mapping is complete and every code has one explicit handling disposition', () => {
  assert.deepEqual([...KB_ERROR_CODES].sort(), Object.keys(EXPECTED_DISPOSITIONS).sort());
  assert.deepEqual(Object.keys(KB_ERROR_MODEL).sort(), [...KB_ERROR_CODES].sort());

  const allowed = new Set(Object.values(KB_ERROR_DISPOSITION));
  for (const code of KB_ERROR_CODES) {
    const definition = KB_ERROR_MODEL[code];
    assert.ok(definition, `missing definition for ${code}`);
    assert.equal(definition.code, code);
    assert.equal(definition.disposition, EXPECTED_DISPOSITIONS[code]);
    assert.ok(allowed.has(definition.disposition));
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 0);
  }
});

test('retry and reconciliation helpers preserve the model semantics', () => {
  for (const code of KB_ERROR_CODES) {
    const disposition = EXPECTED_DISPOSITIONS[code];
    assert.equal(isRetryableKbError(code), disposition === 'retryable');
    assert.equal(
      requiresKbErrorReconciliation(code),
      disposition === 'reconciliation-required',
    );
    assert.equal(getKbErrorDefinition(code), KB_ERROR_MODEL[code]);
  }

  assert.equal(getKbErrorDefinition('NOT_A_KB_ERROR'), null);
  assert.equal(isRetryableKbError('NOT_A_KB_ERROR'), false);
  assert.equal(requiresKbErrorReconciliation('NOT_A_KB_ERROR'), false);
});

test('OUTCOME_UNKNOWN is never treated as a retryable timeout', () => {
  assert.equal(KB_ERROR_MODEL.TIMEOUT.disposition, 'retryable');
  assert.equal(KB_ERROR_MODEL.OUTCOME_UNKNOWN.disposition, 'reconciliation-required');
  assert.equal(isRetryableKbError('OUTCOME_UNKNOWN'), false);
  assert.equal(requiresKbErrorReconciliation('OUTCOME_UNKNOWN'), true);
});
