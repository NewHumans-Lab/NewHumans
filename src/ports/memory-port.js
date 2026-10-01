export const MEMORY_PORT_ID = 'MemoryPort';
export const MEMORY_AUTHORITY = 'KNOWLEDGE_BALL';
export const MEMORY_SCHEMA_VERSION = 'nh.v3.0';

export const MEMORY_BINDING_MODE = Object.freeze({ SELF: 'SELF', HPA: 'HPA' });
export const MEMORY_OPERATION = Object.freeze({
  RECALL: 'recall',
  APPEND_EXPERIENCE: 'append_experience',
  UPDATE_RELATION: 'update_relation',
  HISTORY: 'history',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function memoryError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw memoryError('INVALID_MEMORY_CONTRACT', `${field} must be a UUID`);
  }
  return value;
}

function requireString(value, field, maxLength = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw memoryError('INVALID_MEMORY_CONTRACT', `${field} must be a non-empty string`);
  }
  return value;
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw memoryError('INVALID_MEMORY_CONTRACT', `${field} must be an object`);
  }
  return value;
}

function requireDateTime(value, field) {
  requireString(value, field, 128);
  if (Number.isNaN(Date.parse(value))) {
    throw memoryError('INVALID_MEMORY_CONTRACT', `${field} must be a date-time`);
  }
  return value;
}

function normalizeCursor(cursor) {
  if (cursor === undefined || cursor === null) return undefined;
  return requireString(cursor, 'cursor', 8192);
}

function normalizeLimit(limit) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw memoryError('INVALID_MEMORY_CONTRACT', 'limit must be an integer between 1 and 200');
  }
  return limit;
}

function assertTrustedBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw memoryError('BINDING_MISSING', 'trusted M01 memory subject binding is required');
  }
  requireString(binding.world_id, 'binding.world_id', 256);
  requireUuid(binding.actor_entity_id, 'binding.actor_entity_id');
  if (!['HUMAN', 'AGENT'].includes(binding.actor_entity_type)) {
    throw memoryError('AUTH_FAILED', 'MemoryPort bindings only support HUMAN or AGENT actors', 403);
  }
  if (!Object.values(MEMORY_BINDING_MODE).includes(binding.mode)) {
    throw memoryError('AUTH_FAILED', 'binding.mode must be SELF or HPA', 403);
  }
  if (binding.binding_authority !== 'M01') {
    throw memoryError('AUTH_FAILED', 'MemoryPort binding must come from M01 authority', 403);
  }
  if (binding.mode === MEMORY_BINDING_MODE.HPA) {
    if (binding.actor_entity_type !== 'AGENT') {
      throw memoryError('AUTH_FAILED', 'HPA bindings require an AGENT actor', 403);
    }
    if (binding.human_subject_id === undefined) {
      throw memoryError('BINDING_MISSING', 'HPA binding requires human_subject_id');
    }
    requireUuid(binding.human_subject_id, 'binding.human_subject_id');
  } else if (binding.human_subject_id !== undefined) {
    throw memoryError('AUTH_FAILED', 'SELF bindings must not carry human_subject_id', 403);
  }
  return binding;
}

export function resolveMemorySubject(binding) {
  assertTrustedBinding(binding);
  return binding.mode === MEMORY_BINDING_MODE.HPA
    ? binding.human_subject_id
    : binding.actor_entity_id;
}

export function assertMemorySubjectScope({ binding, subjectId }) {
  requireUuid(subjectId, 'subjectId');
  const resolved = resolveMemorySubject(binding);
  if (resolved !== subjectId) {
    throw memoryError('AUTH_FAILED', 'actor is not authorized for the requested memory subject', 403);
  }
  return resolved;
}

export function assertMemoryAuthorityDescriptor(descriptor) {
  requireObject(descriptor, 'descriptor');
  if (descriptor.authority !== MEMORY_AUTHORITY) {
    throw memoryError('INVALID_MEMORY_AUTHORITY', 'Knowledge Ball is the only durable MemoryPort authority');
  }
  if (descriptor.model_scoped_long_term_memory !== false) {
    throw memoryError(
      'MODEL_SCOPED_LONG_TERM_MEMORY_FORBIDDEN',
      'model-scoped long-term memory is forbidden',
    );
  }
  return descriptor;
}

export function assertSourceProvenance(provenance) {
  requireObject(provenance, 'provenance');
  requireString(provenance.source_id, 'provenance.source_id', 512);
  requireString(provenance.source_kind, 'provenance.source_kind', 128);
  requireString(provenance.source_authority, 'provenance.source_authority', 128);
  requireDateTime(provenance.recorded_at, 'provenance.recorded_at');
  requireUuid(provenance.executor_entity_id, 'provenance.executor_entity_id');
  if (provenance.world_event_id !== undefined) requireString(provenance.world_event_id, 'provenance.world_event_id', 512);
  if (provenance.upstream_source_id !== undefined) requireString(provenance.upstream_source_id, 'provenance.upstream_source_id', 512);
  if (provenance.content_digest !== undefined) requireString(provenance.content_digest, 'provenance.content_digest', 512);
  return provenance;
}

function baseRequest({ binding, subjectId, operation }) {
  const subject = assertMemorySubjectScope({ binding, subjectId });
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    port: MEMORY_PORT_ID,
    authority: MEMORY_AUTHORITY,
    world_id: binding.world_id,
    operation,
    subject_id: subject,
    actor_entity_id: binding.actor_entity_id,
    subject_binding: binding.mode,
  };
}

export function buildRecallRequest({ binding, subjectId, query, cursor, limit, timeRange }) {
  requireObject(query, 'query');
  if (Object.keys(query).length === 0) throw memoryError('INVALID_MEMORY_CONTRACT', 'query must not be empty');
  const request = { ...baseRequest({ binding, subjectId, operation: MEMORY_OPERATION.RECALL }), query };
  const normalizedCursor = normalizeCursor(cursor);
  const normalizedLimit = normalizeLimit(limit);
  if (normalizedCursor !== undefined) request.cursor = normalizedCursor;
  if (normalizedLimit !== undefined) request.limit = normalizedLimit;
  if (timeRange !== undefined) {
    requireObject(timeRange, 'timeRange');
    const range = {};
    if (timeRange.from !== undefined) range.from = requireDateTime(timeRange.from, 'timeRange.from');
    if (timeRange.to !== undefined) range.to = requireDateTime(timeRange.to, 'timeRange.to');
    if (Object.keys(range).length === 0) throw memoryError('INVALID_MEMORY_CONTRACT', 'timeRange must contain from or to');
    request.time_range = range;
  }
  return request;
}

function assertWriteInputs({ binding, idempotencyKey, provenance }) {
  requireString(idempotencyKey, 'idempotencyKey', 512);
  assertTrustedBinding(binding);
  assertSourceProvenance(provenance);
  if (provenance.executor_entity_id !== binding.actor_entity_id) {
    throw memoryError('AUTH_FAILED', 'provenance executor must match the trusted actor', 403);
  }
}

export function buildAppendExperienceCommand({
  binding,
  subjectId,
  idempotencyKey,
  experience,
  occurredAt,
  provenance,
}) {
  assertWriteInputs({ binding, idempotencyKey, provenance });
  requireObject(experience, 'experience');
  if (Object.keys(experience).length === 0) throw memoryError('INVALID_MEMORY_CONTRACT', 'experience must not be empty');
  requireDateTime(occurredAt, 'occurredAt');
  return {
    ...baseRequest({ binding, subjectId, operation: MEMORY_OPERATION.APPEND_EXPERIENCE }),
    idempotency_key: idempotencyKey,
    occurred_at: occurredAt,
    experience,
    provenance,
  };
}

export function buildUpdateRelationCommand({
  binding,
  subjectId,
  idempotencyKey,
  relation,
  expectedVersion,
  provenance,
}) {
  assertWriteInputs({ binding, idempotencyKey, provenance });
  requireObject(relation, 'relation');
  if (Object.keys(relation).length === 0) throw memoryError('INVALID_MEMORY_CONTRACT', 'relation must not be empty');
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
    throw memoryError('INVALID_MEMORY_CONTRACT', 'expectedVersion must be a non-negative integer');
  }
  const command = {
    ...baseRequest({ binding, subjectId, operation: MEMORY_OPERATION.UPDATE_RELATION }),
    idempotency_key: idempotencyKey,
    relation,
    provenance,
  };
  if (expectedVersion !== undefined) command.expected_version = expectedVersion;
  return command;
}

export function buildHistoryRequest({ binding, subjectId, cursor, limit, from, to, kind }) {
  const request = baseRequest({ binding, subjectId, operation: MEMORY_OPERATION.HISTORY });
  const normalizedCursor = normalizeCursor(cursor);
  const normalizedLimit = normalizeLimit(limit);
  if (normalizedCursor !== undefined) request.cursor = normalizedCursor;
  if (normalizedLimit !== undefined) request.limit = normalizedLimit;
  if (from !== undefined) request.from = requireDateTime(from, 'from');
  if (to !== undefined) request.to = requireDateTime(to, 'to');
  if (kind !== undefined) request.kind = requireString(kind, 'kind', 128);
  return request;
}
