import {
  getKbErrorDefinition,
  isRetryableKbError,
  requiresKbErrorReconciliation,
} from '../shared/kb_errors.js';

const REQUIRED_PROVIDER_METHODS = Object.freeze([
  'query',
  'readNode',
  'resolveReference',
  'submitEvidence',
  'createChallenge',
  'readPersonalOverlay',
  'declareBelief',
  'resolvePersonalChallenge',
]);

export const KNOWLEDGE_PORT_VERSION = 'nh.knowledge-port.v1';

export const KNOWLEDGE_REF_KINDS = Object.freeze([
  'NODE',
  'CLAIM',
  'REFERENCE',
  'SOURCE',
  'ASSERTION',
  'EVIDENCE',
  'CHALLENGE',
  'BELIEF',
  'JOB',
  'CORRECTION',
]);

export const KNOWLEDGE_JUDGMENTS = Object.freeze([
  'UNASSESSED',
  'ACCEPTED',
  'CONFIRMED_WRONG',
]);

export const PERSONAL_CHALLENGE_DECISIONS = Object.freeze([
  'UPHOLD',
  'ACCEPT_CORRECTION',
]);

const REF_KIND_SET = new Set(KNOWLEDGE_REF_KINDS);
const JUDGMENT_SET = new Set(KNOWLEDGE_JUDGMENTS);
const CHALLENGE_DECISION_SET = new Set(PERSONAL_CHALLENGE_DECISIONS);

const LEGACY_PROVIDER_ERROR_MAP = Object.freeze({
  DEPENDENCY_UNAVAILABLE: 'UNAVAILABLE',
  KNOWLEDGE_UNAVAILABLE: 'UNAVAILABLE',
  UNAUTHENTICATED: 'AUTH_FAILED',
  FORBIDDEN: 'AUTH_FAILED',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
});

export class KnowledgePortContractError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'KnowledgePortContractError';
    this.code = 'INVALID_KNOWLEDGE_PORT_CONTRACT';
    this.status = 400;
    this.details = details;
  }
}

export class KnowledgePortError extends Error {
  constructor(code, message, { status = 500, details = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KnowledgePortError';
    this.code = code;
    this.status = status;
    this.retryable = isRetryableKbError(code);
    this.reconciliationRequired = requiresKbErrorReconciliation(code);
    this.details = details;
  }
}

function fail(message, details) {
  throw new KnowledgePortContractError(message, details);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertOptionalNonNegativeInteger(value, label) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    fail(`${label} must be a non-negative integer when provided`);
  }
}

function assertIdempotencyKey(value) {
  return assertNonEmptyString(value, 'idempotency_key');
}

function assertSubjectId(value) {
  return assertNonEmptyString(value, 'subject_id');
}

export function assertKnowledgeRef(ref, { kinds } = {}) {
  assertPlainObject(ref, 'knowledge ref');
  assertNonEmptyString(ref.provider, 'knowledge ref.provider');
  assertNonEmptyString(ref.namespace, 'knowledge ref.namespace');
  assertNonEmptyString(ref.id, 'knowledge ref.id');
  if (!REF_KIND_SET.has(ref.kind)) {
    fail(`knowledge ref.kind must be one of ${KNOWLEDGE_REF_KINDS.join(', ')}`);
  }
  if (kinds !== undefined && !kinds.includes(ref.kind)) {
    fail(`knowledge ref.kind ${ref.kind} is not valid for this operation`);
  }
  if (ref.revision !== undefined && !['string', 'number'].includes(typeof ref.revision)) {
    fail('knowledge ref.revision must be a string or number when provided');
  }
  return ref;
}

export function knowledgeRefKey(ref) {
  assertKnowledgeRef(ref);
  return `${ref.provider}\u0000${ref.namespace}\u0000${ref.kind}\u0000${ref.id}`;
}

export function assertKnowledgePortProvider(provider) {
  assertPlainObject(provider, 'knowledge provider');
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      fail(`knowledge provider.${method} must be a function`);
    }
  }
  return provider;
}

function normalizeProviderError(error, operation) {
  if (error instanceof KnowledgePortError) return error;

  const providerCode = typeof error?.code === 'string' ? error.code : null;
  const mappedCode = providerCode === null ? null : (LEGACY_PROVIDER_ERROR_MAP[providerCode] ?? providerCode);
  const definition = mappedCode === null ? null : getKbErrorDefinition(mappedCode);
  const code = definition ? mappedCode : 'UNAVAILABLE';

  return new KnowledgePortError(code, error?.message || `${operation} failed`, {
    status: Number.isInteger(error?.status) ? error.status : code === 'UNAVAILABLE' ? 503 : 500,
    details: {
      operation,
      provider_code: providerCode,
      provider_details: error?.details ?? null,
    },
    cause: error,
  });
}

async function callProvider(provider, operation, input, validateResult) {
  try {
    const result = await provider[operation](input);
    return validateResult(result);
  } catch (error) {
    if (error instanceof KnowledgePortContractError) throw error;
    throw normalizeProviderError(error, operation);
  }
}

function assertQueryInput(input) {
  assertPlainObject(input, 'query input');
  if (input.text === undefined && input.filters === undefined && input.refs === undefined) {
    fail('query requires text, filters, or refs');
  }
  if (input.text !== undefined) assertNonEmptyString(input.text, 'query.text');
  if (input.refs !== undefined) {
    if (!Array.isArray(input.refs)) fail('query.refs must be an array');
    for (const ref of input.refs) assertKnowledgeRef(ref);
  }
  assertOptionalNonNegativeInteger(input.limit, 'query.limit');
  if (input.subject_id !== undefined) assertSubjectId(input.subject_id);
  return input;
}

function assertQueryResult(result) {
  assertPlainObject(result, 'query result');
  if (!Array.isArray(result.items)) fail('query result.items must be an array');
  for (const item of result.items) {
    assertPlainObject(item, 'query result item');
    assertKnowledgeRef(item.ref, { kinds: ['NODE', 'CLAIM', 'REFERENCE', 'ASSERTION'] });
  }
  if (result.next_cursor !== undefined && result.next_cursor !== null) {
    assertNonEmptyString(result.next_cursor, 'query result.next_cursor');
  }
  return result;
}

function assertNodeReadInput(input) {
  assertPlainObject(input, 'node read input');
  assertKnowledgeRef(input.ref, { kinds: ['NODE', 'CLAIM', 'REFERENCE', 'ASSERTION'] });
  return input;
}

function assertNodeReadResult(result) {
  assertPlainObject(result, 'node read result');
  assertKnowledgeRef(result.ref, { kinds: ['NODE', 'CLAIM', 'REFERENCE', 'ASSERTION'] });
  if (result.evidence_refs !== undefined) {
    if (!Array.isArray(result.evidence_refs)) fail('node read result.evidence_refs must be an array');
    for (const ref of result.evidence_refs) assertKnowledgeRef(ref, { kinds: ['EVIDENCE'] });
  }
  if (result.challenge_refs !== undefined) {
    if (!Array.isArray(result.challenge_refs)) fail('node read result.challenge_refs must be an array');
    for (const ref of result.challenge_refs) assertKnowledgeRef(ref, { kinds: ['CHALLENGE'] });
  }
  return result;
}

function assertResolveReferenceInput(input) {
  assertPlainObject(input, 'reference input');
  assertKnowledgeRef(input.ref);
  return input;
}

function assertResolveReferenceResult(result) {
  assertPlainObject(result, 'reference result');
  assertKnowledgeRef(result.ref);
  if (result.canonical_ref !== undefined && result.canonical_ref !== null) {
    assertKnowledgeRef(result.canonical_ref);
  }
  if (result.status !== undefined) assertNonEmptyString(result.status, 'reference result.status');
  return result;
}

function assertEvidenceInput(input) {
  assertPlainObject(input, 'evidence input');
  assertKnowledgeRef(input.target_ref, { kinds: ['NODE', 'CLAIM', 'ASSERTION', 'REFERENCE'] });
  assertKnowledgeRef(input.source_ref, { kinds: ['SOURCE', 'REFERENCE'] });
  if (!['SUPPORTS', 'REFUTES', 'CONTEXT'].includes(input.stance)) {
    fail('evidence.stance must be SUPPORTS, REFUTES, or CONTEXT');
  }
  assertIdempotencyKey(input.idempotency_key);
  assertOptionalNonNegativeInteger(input.expected_version, 'evidence.expected_version');
  return input;
}

function assertEvidenceResult(result) {
  assertPlainObject(result, 'evidence result');
  assertKnowledgeRef(result.evidence_ref, { kinds: ['EVIDENCE'] });
  if (result.duplicate_of !== undefined && result.duplicate_of !== null) {
    assertKnowledgeRef(result.duplicate_of, { kinds: ['EVIDENCE'] });
  }
  return result;
}

function assertChallengeInput(input) {
  assertPlainObject(input, 'challenge input');
  assertKnowledgeRef(input.target_ref, { kinds: ['NODE', 'CLAIM', 'ASSERTION', 'REFERENCE'] });
  if (input.evidence_refs !== undefined) {
    if (!Array.isArray(input.evidence_refs)) fail('challenge.evidence_refs must be an array');
    for (const ref of input.evidence_refs) assertKnowledgeRef(ref, { kinds: ['EVIDENCE'] });
  }
  assertNonEmptyString(input.objection_type, 'challenge.objection_type');
  assertNonEmptyString(input.requested_outcome, 'challenge.requested_outcome');
  assertIdempotencyKey(input.idempotency_key);
  assertOptionalNonNegativeInteger(input.expected_version, 'challenge.expected_version');
  return input;
}

function assertChallengeResult(result) {
  assertPlainObject(result, 'challenge result');
  assertKnowledgeRef(result.challenge_ref, { kinds: ['CHALLENGE'] });
  if (result.status !== undefined) assertNonEmptyString(result.status, 'challenge result.status');
  return result;
}

function assertOverlayInput(input) {
  assertPlainObject(input, 'personal overlay input');
  assertSubjectId(input.subject_id);
  if (input.node_refs !== undefined) {
    if (!Array.isArray(input.node_refs)) fail('personal overlay.node_refs must be an array');
    for (const ref of input.node_refs) assertKnowledgeRef(ref, { kinds: ['NODE', 'CLAIM', 'REFERENCE', 'ASSERTION'] });
  }
  assertOptionalNonNegativeInteger(input.limit, 'personal overlay.limit');
  return input;
}

function assertOverlayResult(result, expectedSubjectId) {
  assertPlainObject(result, 'personal overlay result');
  if (result.subject_id !== expectedSubjectId) {
    fail('personal overlay result.subject_id must match the requested subject');
  }
  if (!Array.isArray(result.items)) fail('personal overlay result.items must be an array');
  for (const item of result.items) {
    assertPlainObject(item, 'personal overlay item');
    assertKnowledgeRef(item.node_ref, { kinds: ['NODE', 'CLAIM', 'REFERENCE', 'ASSERTION'] });
    if (!JUDGMENT_SET.has(item.judgment)) {
      fail(`personal overlay item.judgment must be one of ${KNOWLEDGE_JUDGMENTS.join(', ')}`);
    }
    if (!Number.isInteger(item.pending_challenge_count) || item.pending_challenge_count < 0) {
      fail('personal overlay item.pending_challenge_count must be a non-negative integer');
    }
    if (item.correction_refs !== undefined) {
      if (!Array.isArray(item.correction_refs)) fail('personal overlay item.correction_refs must be an array');
      for (const ref of item.correction_refs) assertKnowledgeRef(ref, { kinds: ['CORRECTION', 'NODE', 'CLAIM', 'REFERENCE'] });
    }
  }
  return result;
}

function assertBeliefInput(input) {
  assertPlainObject(input, 'belief input');
  assertSubjectId(input.subject_id);
  assertKnowledgeRef(input.target_ref, { kinds: ['NODE', 'CLAIM', 'REFERENCE', 'ASSERTION'] });
  if (!['ACCEPT', 'RETRACT'].includes(input.position)) {
    fail('belief.position must be ACCEPT or RETRACT');
  }
  assertIdempotencyKey(input.idempotency_key);
  assertOptionalNonNegativeInteger(input.expected_version, 'belief.expected_version');
  if (input.confirmation_ref !== undefined) assertNonEmptyString(input.confirmation_ref, 'belief.confirmation_ref');
  return input;
}

function assertBeliefResult(result, expectedSubjectId) {
  assertPlainObject(result, 'belief result');
  if (result.subject_id !== expectedSubjectId) fail('belief result.subject_id must match the requested subject');
  assertKnowledgeRef(result.belief_ref, { kinds: ['BELIEF'] });
  if (!JUDGMENT_SET.has(result.judgment)) {
    fail(`belief result.judgment must be one of ${KNOWLEDGE_JUDGMENTS.join(', ')}`);
  }
  return result;
}

function assertResolveChallengeInput(input) {
  assertPlainObject(input, 'personal challenge resolution input');
  assertSubjectId(input.subject_id);
  assertKnowledgeRef(input.challenge_ref, { kinds: ['CHALLENGE'] });
  if (!CHALLENGE_DECISION_SET.has(input.decision)) {
    fail(`personal challenge decision must be one of ${PERSONAL_CHALLENGE_DECISIONS.join(', ')}`);
  }
  if (input.decision === 'ACCEPT_CORRECTION') {
    assertKnowledgeRef(input.correction_ref, { kinds: ['CORRECTION', 'NODE', 'CLAIM', 'REFERENCE'] });
  }
  assertNonEmptyString(input.evidence_version, 'personal challenge evidence_version');
  assertIdempotencyKey(input.idempotency_key);
  assertOptionalNonNegativeInteger(input.expected_version, 'personal challenge expected_version');
  if (input.confirmation_ref !== undefined) {
    assertNonEmptyString(input.confirmation_ref, 'personal challenge confirmation_ref');
  }
  return input;
}

function assertResolveChallengeResult(result, expectedSubjectId) {
  assertPlainObject(result, 'personal challenge resolution result');
  if (result.subject_id !== expectedSubjectId) {
    fail('personal challenge resolution result.subject_id must match the requested subject');
  }
  assertKnowledgeRef(result.challenge_ref, { kinds: ['CHALLENGE'] });
  if (!JUDGMENT_SET.has(result.judgment)) {
    fail(`personal challenge resolution result.judgment must be one of ${KNOWLEDGE_JUDGMENTS.join(', ')}`);
  }
  if (!Number.isInteger(result.remaining_pending) || result.remaining_pending < 0) {
    fail('personal challenge resolution result.remaining_pending must be a non-negative integer');
  }
  return result;
}

export function createKnowledgePort(provider) {
  assertKnowledgePortProvider(provider);

  return Object.freeze({
    version: KNOWLEDGE_PORT_VERSION,

    async query(input) {
      assertQueryInput(input);
      return callProvider(provider, 'query', input, assertQueryResult);
    },

    async readNode(input) {
      assertNodeReadInput(input);
      return callProvider(provider, 'readNode', input, assertNodeReadResult);
    },

    async resolveReference(input) {
      assertResolveReferenceInput(input);
      return callProvider(provider, 'resolveReference', input, assertResolveReferenceResult);
    },

    async submitEvidence(input) {
      assertEvidenceInput(input);
      return callProvider(provider, 'submitEvidence', input, assertEvidenceResult);
    },

    async createChallenge(input) {
      assertChallengeInput(input);
      return callProvider(provider, 'createChallenge', input, assertChallengeResult);
    },

    async readPersonalOverlay(input) {
      assertOverlayInput(input);
      return callProvider(provider, 'readPersonalOverlay', input, (result) => assertOverlayResult(result, input.subject_id));
    },

    async declareBelief(input) {
      assertBeliefInput(input);
      return callProvider(provider, 'declareBelief', input, (result) => assertBeliefResult(result, input.subject_id));
    },

    async resolvePersonalChallenge(input) {
      assertResolveChallengeInput(input);
      return callProvider(provider, 'resolvePersonalChallenge', input, (result) => assertResolveChallengeResult(result, input.subject_id));
    },
  });
}
