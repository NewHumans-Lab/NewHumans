export const KB_ERROR_DISPOSITION = Object.freeze({
  RETRYABLE: 'retryable',
  NON_RETRYABLE: 'non-retryable',
  RECONCILIATION_REQUIRED: 'reconciliation-required',
});

export const KB_ERROR_CODES = Object.freeze([
  'UNAVAILABLE',
  'TIMEOUT',
  'AUTH_FAILED',
  'BINDING_MISSING',
  'STALE_VERSION',
  'INSUFFICIENT_ENERGY',
  'CONFLICT',
  'OUTCOME_UNKNOWN',
]);

const DEFINITIONS = {
  UNAVAILABLE: {
    disposition: KB_ERROR_DISPOSITION.RETRYABLE,
    description: 'The Knowledge Ball provider or a required dependency is temporarily unavailable.',
  },
  TIMEOUT: {
    disposition: KB_ERROR_DISPOSITION.RETRYABLE,
    description: 'The operation exceeded its deadline but is safe to retry; ambiguous committed writes must use OUTCOME_UNKNOWN instead.',
  },
  AUTH_FAILED: {
    disposition: KB_ERROR_DISPOSITION.NON_RETRYABLE,
    description: 'Authentication or authorization failed; the same request must not be retried until credentials or grants change.',
  },
  BINDING_MISSING: {
    disposition: KB_ERROR_DISPOSITION.NON_RETRYABLE,
    description: 'A required NewHumans-to-Knowledge-Ball identity or subject binding is absent.',
  },
  STALE_VERSION: {
    disposition: KB_ERROR_DISPOSITION.RETRYABLE,
    description: 'The caller used an obsolete version and may retry only after refreshing authoritative state.',
  },
  INSUFFICIENT_ENERGY: {
    disposition: KB_ERROR_DISPOSITION.NON_RETRYABLE,
    description: 'The authoritative Knowledge Ball Energy balance cannot fund the requested operation.',
  },
  CONFLICT: {
    disposition: KB_ERROR_DISPOSITION.NON_RETRYABLE,
    description: 'The request conflicts with current authoritative state; an unchanged retry is not valid.',
  },
  OUTCOME_UNKNOWN: {
    disposition: KB_ERROR_DISPOSITION.RECONCILIATION_REQUIRED,
    description: 'The request may have committed but its outcome is unknown; reconcile before any replay.',
  },
};

export const KB_ERROR_MODEL = Object.freeze(
  Object.fromEntries(
    Object.entries(DEFINITIONS).map(([code, definition]) => [code, Object.freeze({ code, ...definition })]),
  ),
);

export function getKbErrorDefinition(code) {
  return KB_ERROR_MODEL[code] ?? null;
}

export function isRetryableKbError(code) {
  return KB_ERROR_MODEL[code]?.disposition === KB_ERROR_DISPOSITION.RETRYABLE;
}

export function requiresKbErrorReconciliation(code) {
  return KB_ERROR_MODEL[code]?.disposition === KB_ERROR_DISPOSITION.RECONCILIATION_REQUIRED;
}
