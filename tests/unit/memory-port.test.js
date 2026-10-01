import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_AUTHORITY,
  assertMemoryAuthorityDescriptor,
  buildAppendExperienceCommand,
  buildHistoryRequest,
  buildRecallRequest,
  buildUpdateRelationCommand,
  resolveMemorySubject,
} from '../../src/ports/memory-port.js';
import { KB_ERROR_CODES } from '../../src/shared/kb_errors.js';

const world = 'world-1';
const human = '00000000-0000-4000-8000-000000000001';
const agent = '00000000-0000-4000-8000-000000000002';
const otherHuman = '00000000-0000-4000-8000-000000000003';

const humanBinding = {
  world_id: world,
  actor_entity_id: human,
  actor_entity_type: 'HUMAN',
  mode: 'SELF',
  binding_authority: 'M01',
};
const hpaBinding = {
  world_id: world,
  actor_entity_id: agent,
  actor_entity_type: 'AGENT',
  mode: 'HPA',
  human_subject_id: human,
  binding_authority: 'M01',
};
const independentAgentBinding = {
  world_id: world,
  actor_entity_id: agent,
  actor_entity_type: 'AGENT',
  mode: 'SELF',
  binding_authority: 'M01',
};
const provenance = {
  source_id: 'source-1',
  source_kind: 'M01_EVENT',
  source_authority: 'M01',
  recorded_at: '2026-10-01T06:00:00Z',
  executor_entity_id: agent,
  world_event_id: 'event-1',
};

test('HPA and Human resolve to the same Human long-term memory subject', () => {
  assert.equal(resolveMemorySubject(humanBinding), human);
  assert.equal(resolveMemorySubject(hpaBinding), human);
  assert.equal(resolveMemorySubject(humanBinding), resolveMemorySubject(hpaBinding));
});

test('subject isolation rejects cross-subject recall and history', () => {
  assert.throws(
    () => buildRecallRequest({ binding: humanBinding, subjectId: otherHuman, query: { text: 'x' } }),
    (error) => error.code === 'AUTH_FAILED',
  );
  assert.throws(
    () => buildHistoryRequest({ binding: hpaBinding, subjectId: otherHuman }),
    (error) => error.code === 'AUTH_FAILED',
  );
});

test('an independent Agent cannot write another subject memory', () => {
  assert.throws(
    () => buildAppendExperienceCommand({
      binding: independentAgentBinding,
      subjectId: human,
      idempotencyKey: 'experience-1',
      occurredAt: '2026-10-01T05:59:00Z',
      experience: { kind: 'OBSERVATION', text: 'example' },
      provenance,
    }),
    (error) => error.code === 'AUTH_FAILED',
  );
});

test('HPA write uses Human subject while preserving world and HPA executor provenance', () => {
  const command = buildAppendExperienceCommand({
    binding: hpaBinding,
    subjectId: human,
    idempotencyKey: 'experience-2',
    occurredAt: '2026-10-01T05:59:00Z',
    experience: { kind: 'PROXY_OBSERVATION', text: 'example' },
    provenance,
  });
  assert.equal(command.world_id, world);
  assert.equal(command.subject_id, human);
  assert.equal(command.actor_entity_id, agent);
  assert.equal(command.provenance.executor_entity_id, agent);
  assert.equal(command.authority, MEMORY_AUTHORITY);
});

test('source provenance cannot impersonate a different executor', () => {
  assert.throws(
    () => buildUpdateRelationCommand({
      binding: hpaBinding,
      subjectId: human,
      idempotencyKey: 'relation-forged',
      relation: { relation_type: 'memory_association', from_ref: 'node-a', to_ref: 'node-b' },
      provenance: { ...provenance, executor_entity_id: otherHuman },
    }),
    (error) => error.code === 'AUTH_FAILED',
  );
});

test('repeat-write contract preserves the same MemoryPort request and idempotency key', () => {
  const first = buildUpdateRelationCommand({
    binding: hpaBinding,
    subjectId: human,
    idempotencyKey: 'relation-1',
    expectedVersion: 3,
    relation: { relation_type: 'memory_association', from_ref: 'node-a', to_ref: 'node-b' },
    provenance,
  });
  const replay = buildUpdateRelationCommand({
    binding: hpaBinding,
    subjectId: human,
    idempotencyKey: 'relation-1',
    expectedVersion: 3,
    relation: { relation_type: 'memory_association', from_ref: 'node-a', to_ref: 'node-b' },
    provenance: { ...provenance },
  });
  assert.deepEqual(replay, first);
  assert.equal(replay.idempotency_key, 'relation-1');
  assert.equal(replay.world_id, world);
  assert.equal(replay.actor_entity_id, agent);
  assert.equal(replay.operation, 'update_relation');
});

test('cursor is opaque pass-through and remains scoped by the trusted subject binding', () => {
  const request = buildRecallRequest({
    binding: hpaBinding,
    subjectId: human,
    query: { text: 'latest work' },
    cursor: 'kb:opaque:cursor:001',
    limit: 20,
  });
  assert.equal(request.cursor, 'kb:opaque:cursor:001');
  assert.equal(request.subject_id, human);
});

test('MemoryPort provider-facing authorization failures reuse the NH-008 KB error model', () => {
  assert.equal(KB_ERROR_CODES.includes('AUTH_FAILED'), true);
  assert.equal(KB_ERROR_CODES.includes('BINDING_MISSING'), true);
  assert.equal(KB_ERROR_CODES.includes('STALE_VERSION'), true);
  assert.equal(KB_ERROR_CODES.includes('OUTCOME_UNKNOWN'), true);
});

test('Knowledge Ball is the only accepted durable memory authority', () => {
  assert.deepEqual(
    assertMemoryAuthorityDescriptor({ authority: 'KNOWLEDGE_BALL', model_scoped_long_term_memory: false }),
    { authority: 'KNOWLEDGE_BALL', model_scoped_long_term_memory: false },
  );
  assert.throws(
    () => assertMemoryAuthorityDescriptor({ authority: 'MODEL_VENDOR', model_scoped_long_term_memory: true }),
    (error) => error.code === 'INVALID_MEMORY_AUTHORITY',
  );
  assert.throws(
    () => assertMemoryAuthorityDescriptor({ authority: 'KNOWLEDGE_BALL', model_scoped_long_term_memory: true }),
    (error) => error.code === 'MODEL_SCOPED_LONG_TERM_MEMORY_FORBIDDEN',
  );
});
