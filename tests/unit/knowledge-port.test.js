import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KnowledgePortContractError,
  KnowledgePortError,
  assertKnowledgeRef,
  createKnowledgePort,
  knowledgeRefKey,
} from '../../src/ports/knowledge_port.js';

const nodeRef = Object.freeze({ provider: 'knowledge-ball', namespace: 'public', kind: 'NODE', id: 'node-42' });
const sourceRef = Object.freeze({ provider: 'knowledge-ball', namespace: 'public', kind: 'SOURCE', id: 'source-7' });
const correctionRef = Object.freeze({ provider: 'knowledge-ball', namespace: 'public', kind: 'CORRECTION', id: 'correction-9' });

function providerError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function makeContractProvider() {
  const evidenceWrites = new Map();
  const overlay = new Map([
    ['human-a', { judgment: 'ACCEPTED', pending: 0, corrections: [] }],
    ['human-b', { judgment: 'UNASSESSED', pending: 0, corrections: [] }],
  ]);
  let evidenceSequence = 0;
  let challengeSequence = 0;

  function digestEvidence(input) {
    return JSON.stringify({
      target: knowledgeRefKey(input.target_ref),
      source: knowledgeRefKey(input.source_ref),
      stance: input.stance,
    });
  }

  return {
    evidenceWrites,

    async query(input) {
      if (input.text === 'provider-down') throw providerError('UNAVAILABLE', 'knowledge provider is unavailable', 503);
      return { items: [{ ref: nodeRef, display: { label: 'external projection only' } }], next_cursor: null };
    },

    async readNode(input) {
      if (input.ref.id === 'read-failure') throw providerError('TIMEOUT', 'knowledge node read timed out', 504);
      return { ref: input.ref, evidence_refs: [], challenge_refs: [], version: 3 };
    },

    async resolveReference(input) {
      return { ref: input.ref, canonical_ref: input.ref, status: 'CANONICAL' };
    },

    async submitEvidence(input) {
      const existing = evidenceWrites.get(input.idempotency_key);
      const digest = digestEvidence(input);
      if (existing) {
        if (existing.digest !== digest) throw providerError('CONFLICT', 'same key has different evidence payload', 409);
        return existing.result;
      }
      evidenceSequence += 1;
      const result = {
        evidence_ref: {
          provider: 'knowledge-ball',
          namespace: 'public',
          kind: 'EVIDENCE',
          id: `evidence-${evidenceSequence}`,
        },
        duplicate_of: null,
      };
      evidenceWrites.set(input.idempotency_key, { digest, result });
      return result;
    },

    async createChallenge() {
      challengeSequence += 1;
      const challenge_ref = {
        provider: 'knowledge-ball',
        namespace: 'public',
        kind: 'CHALLENGE',
        id: `challenge-${challengeSequence}`,
      };
      for (const state of overlay.values()) state.pending += 1;
      return { challenge_ref, status: 'OPEN' };
    },

    async readPersonalOverlay(input) {
      const state = overlay.get(input.subject_id);
      return {
        subject_id: input.subject_id,
        items: [{
          node_ref: nodeRef,
          judgment: state.judgment,
          seen: true,
          remembers: true,
          created_by_self: false,
          pending_challenge_count: state.pending,
          correction_refs: [...state.corrections],
          state_version: 1,
        }],
        next_cursor: null,
      };
    },

    async declareBelief(input) {
      const state = overlay.get(input.subject_id);
      state.judgment = input.position === 'ACCEPT' ? 'ACCEPTED' : 'UNASSESSED';
      return {
        subject_id: input.subject_id,
        belief_ref: {
          provider: 'knowledge-ball',
          namespace: 'personal',
          kind: 'BELIEF',
          id: `belief-${input.subject_id}-1`,
        },
        judgment: state.judgment,
        state_version: 2,
      };
    },

    async resolvePersonalChallenge(input) {
      const state = overlay.get(input.subject_id);
      state.pending = Math.max(0, state.pending - 1);
      if (input.decision === 'ACCEPT_CORRECTION') {
        state.judgment = 'CONFIRMED_WRONG';
        state.corrections.push(input.correction_ref);
      }
      return {
        subject_id: input.subject_id,
        challenge_ref: input.challenge_ref,
        judgment: state.judgment,
        remaining_pending: state.pending,
        correction_refs: [...state.corrections],
        state_version: 2,
      };
    },
  };
}

test('knowledge IDs are opaque external stable references, never local numeric IDs', () => {
  assert.equal(assertKnowledgeRef(nodeRef), nodeRef);
  assert.throws(
    () => assertKnowledgeRef({ provider: 'knowledge-ball', namespace: 'public', kind: 'NODE', id: 42 }),
    (error) => error instanceof KnowledgePortContractError,
  );
  assert.throws(
    () => assertKnowledgeRef({ namespace: 'public', kind: 'NODE', id: 'local-row-42' }),
    (error) => error instanceof KnowledgePortContractError,
  );
});

test('query/read provider failures stay explicit and use the authoritative KB error model', async () => {
  const port = createKnowledgePort(makeContractProvider());

  await assert.rejects(
    port.query({ text: 'provider-down', limit: 10 }),
    (error) => error instanceof KnowledgePortError
      && error.code === 'UNAVAILABLE'
      && error.status === 503
      && error.retryable === true
      && error.reconciliationRequired === false,
  );

  await assert.rejects(
    port.readNode({ ref: { ...nodeRef, id: 'read-failure' } }),
    (error) => error instanceof KnowledgePortError
      && error.code === 'TIMEOUT'
      && error.status === 504
      && error.retryable === true,
  );
});

test('legacy provider error names are normalized to the single NH-008 error authority', async () => {
  const provider = makeContractProvider();
  provider.query = async () => {
    throw providerError('DEPENDENCY_UNAVAILABLE', 'legacy dependency name', 503);
  };
  const port = createKnowledgePort(provider);

  await assert.rejects(
    port.query({ text: 'anything' }),
    (error) => error instanceof KnowledgePortError
      && error.code === 'UNAVAILABLE'
      && error.details.provider_code === 'DEPENDENCY_UNAVAILABLE',
  );
});

test('evidence writes require idempotency and repeated identical writes return the same external ref', async () => {
  const provider = makeContractProvider();
  const port = createKnowledgePort(provider);
  const input = {
    target_ref: nodeRef,
    source_ref: sourceRef,
    stance: 'SUPPORTS',
    idempotency_key: 'evidence-write-1',
  };

  const first = await port.submitEvidence(input);
  const retry = await port.submitEvidence({ ...input });
  assert.deepEqual(retry, first);
  assert.equal(provider.evidenceWrites.size, 1);

  await assert.rejects(
    port.submitEvidence({ ...input, stance: 'REFUTES' }),
    (error) => error instanceof KnowledgePortError && error.code === 'CONFLICT' && error.retryable === false,
  );

  await assert.rejects(
    port.submitEvidence({ target_ref: nodeRef, source_ref: sourceRef, stance: 'SUPPORTS' }),
    (error) => error instanceof KnowledgePortContractError,
  );
});

test('challenge lifecycle is externally referenced and personal judgment remains isolated by subject', async () => {
  const port = createKnowledgePort(makeContractProvider());
  const challenge = await port.createChallenge({
    target_ref: nodeRef,
    evidence_refs: [],
    objection_type: 'FACTUAL_ERROR',
    requested_outcome: 'CORRECT_OR_LIMIT',
    idempotency_key: 'challenge-write-1',
  });

  const beforeA = await port.readPersonalOverlay({ subject_id: 'human-a', node_refs: [nodeRef] });
  const beforeB = await port.readPersonalOverlay({ subject_id: 'human-b', node_refs: [nodeRef] });
  assert.equal(beforeA.items[0].pending_challenge_count, 1);
  assert.equal(beforeB.items[0].pending_challenge_count, 1);

  const resolvedA = await port.resolvePersonalChallenge({
    challenge_ref: challenge.challenge_ref,
    subject_id: 'human-a',
    decision: 'ACCEPT_CORRECTION',
    correction_ref: correctionRef,
    evidence_version: 'evidence-set-v2',
    expected_version: 1,
    idempotency_key: 'resolve-human-a-1',
    confirmation_ref: 'human-confirmation-123',
  });
  assert.equal(resolvedA.judgment, 'CONFIRMED_WRONG');
  assert.equal(resolvedA.remaining_pending, 0);

  const afterA = await port.readPersonalOverlay({ subject_id: 'human-a', node_refs: [nodeRef] });
  const afterB = await port.readPersonalOverlay({ subject_id: 'human-b', node_refs: [nodeRef] });
  assert.equal(afterA.items[0].judgment, 'CONFIRMED_WRONG');
  assert.equal(afterA.items[0].pending_challenge_count, 0);
  assert.equal(afterB.items[0].judgment, 'UNASSESSED');
  assert.equal(afterB.items[0].pending_challenge_count, 1);
});

test('belief writes return personal judgment but do not create a second current-state authority', async () => {
  const port = createKnowledgePort(makeContractProvider());
  const result = await port.declareBelief({
    subject_id: 'human-b',
    target_ref: nodeRef,
    position: 'ACCEPT',
    expected_version: 0,
    idempotency_key: 'belief-human-b-1',
    confirmation_ref: 'human-confirmation-456',
  });
  assert.equal(result.judgment, 'ACCEPTED');
  assert.equal(result.belief_ref.kind, 'BELIEF');

  const overlay = await port.readPersonalOverlay({ subject_id: 'human-b', node_refs: [nodeRef] });
  assert.equal(overlay.items[0].judgment, 'ACCEPTED');
});
