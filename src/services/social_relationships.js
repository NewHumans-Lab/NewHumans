import crypto from 'node:crypto';

const TYPE_RULES = Object.freeze({
  considers_friend: { mode: 'UNILATERAL', sourceKind: 'ENTITY_DECLARATION', recordType: 'DECLARATION' },
  mutual_friendship: { mode: 'MUTUAL', sourceKind: 'MUTUAL_CONFIRMATION', recordType: 'CONFIRMATION' },
  worked_with: { mode: 'DERIVED', sourceKind: 'CONTRACT', recordType: 'CONTRACT' },
  completed_contract_with: { mode: 'DERIVED', sourceKind: 'CONTRACT', recordType: 'CONTRACT' },
  employed_by: { mode: 'DERIVED', sourceKind: 'CONTRACT', recordType: 'CONTRACT' },
  member_of: { mode: 'DERIVED', sourceKind: 'MEMBERSHIP', recordType: 'MEMBERSHIP' },
  manages: { mode: 'DERIVED', sourceKind: 'ROLE_ASSIGNMENT', recordType: 'ROLE_ASSIGNMENT' },
  created_by: { mode: 'DERIVED', sourceKind: 'BIRTH_PROTOCOL', recordType: 'BIRTH_PROTOCOL' },
  parent_of: { mode: 'DERIVED', sourceKind: 'BIRTH_PROTOCOL', recordType: 'BIRTH_PROTOCOL' },
});
const STATUSES = new Set(['ACTIVE', 'ENDED']);
const DISPUTE_STATUSES = new Set(['NONE', 'OPEN', 'RESOLVED']);

function domainError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw domainError('INVALID_TIMESTAMP', 'timestamp must be a valid date-time');
  return date.toISOString();
}

function requireRelationshipType(relationshipType) {
  const value = String(relationshipType ?? '').trim();
  const rule = TYPE_RULES[value];
  if (!rule) throw domainError('INVALID_RELATIONSHIP_TYPE', 'relationshipType is not a registered M04 relationship type');
  return { relationshipType: value, rule };
}

function requireState(status = 'ACTIVE', disputeStatus = 'NONE') {
  const normalizedStatus = String(status).toUpperCase();
  const normalizedDispute = String(disputeStatus).toUpperCase();
  if (!STATUSES.has(normalizedStatus)) throw domainError('INVALID_RELATIONSHIP_STATUS', 'relationship status must be ACTIVE or ENDED');
  if (!DISPUTE_STATUSES.has(normalizedDispute)) {
    throw domainError('INVALID_RELATIONSHIP_DISPUTE_STATUS', 'disputeStatus must be NONE, OPEN, or RESOLVED');
  }
  return { status: normalizedStatus, disputeStatus: normalizedDispute };
}

function requirePeriod(status, validFrom, validUntil = null) {
  const from = new Date(validFrom);
  if (Number.isNaN(from.getTime())) throw domainError('INVALID_VALIDITY_PERIOD', 'validFrom must be a valid timestamp');
  if (validUntil == null) {
    if (status === 'ENDED') throw domainError('INVALID_VALIDITY_PERIOD', 'ENDED relationships require validUntil');
    return { validFrom: from.toISOString(), validUntil: null };
  }
  const until = new Date(validUntil);
  if (Number.isNaN(until.getTime()) || until <= from) {
    throw domainError('INVALID_VALIDITY_PERIOD', 'validUntil must be later than validFrom');
  }
  return { validFrom: from.toISOString(), validUntil: until.toISOString() };
}

function canonicalMutualPair(a, b) {
  if (!a || !b || a === b) throw domainError('INVALID_RELATIONSHIP_PARTIES', 'relationship parties must be distinct');
  return String(a) < String(b) ? [a, b] : [b, a];
}

async function actionTime(client, actionId) {
  const result = await client.query(
    'SELECT created_at, created_at::text AS created_at_exact FROM core.actions WHERE action_id=$1',
    [actionId],
  );
  if (result.rowCount !== 1) throw domainError('ACTION_EVIDENCE_MISSING', 'relationship action evidence is missing', 409);
  return { exact: result.rows[0].created_at_exact, iso: iso(result.rows[0].created_at) };
}

function actorProvenance({ sourceKind, recordType, actionId, occurredAt, participantRole }) {
  return {
    source_kind: sourceKind,
    records: [{
      record_type: recordType,
      record_id: actionId,
      participant_role: participantRole,
      occurred_at: occurredAt,
    }],
  };
}

function derivedProvenance(rule, sourceRef) {
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) {
    throw domainError('INVALID_SOURCE_REF', 'derived relationships require a structured sourceRef');
  }
  const kind = String(sourceRef.kind ?? '').trim().toUpperCase();
  const id = String(sourceRef.id ?? '').trim();
  if (kind !== rule.sourceKind || !id || sourceRef.occurredAt == null) {
    throw domainError('INVALID_SOURCE_REF', `sourceRef.kind must be ${rule.sourceKind}; sourceRef.id and sourceRef.occurredAt are required`);
  }
  const occurredAt = iso(sourceRef.occurredAt);
  const record = {
    record_type: rule.recordType,
    record_id: id,
    occurred_at: occurredAt,
  };
  if (sourceRef.participantRole != null) {
    const role = String(sourceRef.participantRole).toUpperCase();
    if (!['SUBJECT', 'OBJECT'].includes(role)) throw domainError('INVALID_SOURCE_REF', 'sourceRef.participantRole must be SUBJECT or OBJECT');
    record.participant_role = role;
  }
  if (sourceRef.version != null) {
    const version = sourceRef.version;
    if ((typeof version === 'number' && (!Number.isInteger(version) || version < 1))
        || (typeof version === 'string' && !version.trim())
        || !['number', 'string'].includes(typeof version)) {
      throw domainError('INVALID_SOURCE_REF', 'sourceRef.version must be a positive integer or non-empty string');
    }
    record.record_version = version;
  }
  return { source_kind: rule.sourceKind, records: [record] };
}

async function loadHeader(client, worldId, relationshipId) {
  const result = await client.query(
    `SELECT relationship_id, world_id, subject_entity_id, object_entity_id, relationship_type, relationship_mode, created_at
       FROM social.relationships
      WHERE world_id=$1 AND relationship_id=$2`,
    [worldId, relationshipId],
  );
  if (result.rowCount !== 1) throw domainError('RELATIONSHIP_NOT_FOUND', 'relationship not found', 404);
  return result.rows[0];
}

async function nextVersion(client, relationshipId) {
  const result = await client.query(
    `SELECT COALESCE(MAX(version),0)::int + 1 AS next_version
       FROM social.relationship_versions
      WHERE relationship_id=$1`,
    [relationshipId],
  );
  return result.rows[0].next_version;
}

async function insertVersion(client, {
  relationshipId,
  worldId,
  version,
  status,
  disputeStatus,
  changedAt,
  validFrom,
  validUntil,
  provenance,
  mutualProposalId = null,
  actorEntityId,
  actionId,
}) {
  const result = await client.query(
    `INSERT INTO social.relationship_versions
      (relationship_id,version,world_id,status,dispute_status,changed_at,valid_from,valid_until,provenance,mutual_proposal_id,recorded_by_entity_id,recorded_action_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     RETURNING relationship_id,version,world_id,status,dispute_status,changed_at,valid_from,valid_until,provenance,mutual_proposal_id,recorded_by_entity_id,recorded_at`,
    [relationshipId, version, worldId, status, disputeStatus, changedAt, validFrom, validUntil, JSON.stringify(provenance), mutualProposalId, actorEntityId, actionId],
  );
  return result.rows[0];
}

export async function recordRelationship(client, input, context) {
  const { relationshipType, rule } = requireRelationshipType(input.relationshipType);
  if (rule.mode === 'MUTUAL') {
    throw domainError('MUTUAL_CONFIRMATIONS_REQUIRED', 'mutual relationships must use proposeMutualRelationship and confirmMutualRelationship', 409);
  }
  const mode = String(input.mode ?? '').toUpperCase();
  if (mode !== rule.mode) {
    throw domainError('RELATIONSHIP_MODE_MISMATCH', `${relationshipType} must use relationship mode ${rule.mode}`, 409);
  }
  const state = requireState(input.status ?? 'ACTIVE', input.disputeStatus ?? 'NONE');
  const period = requirePeriod(state.status, input.validFrom, input.validUntil);
  const relationshipId = input.relationshipId ?? crypto.randomUUID();

  if (!input.subjectEntityId || !input.objectEntityId || input.subjectEntityId === input.objectEntityId) {
    throw domainError('INVALID_RELATIONSHIP_PARTIES', 'relationship parties must be distinct');
  }
  if (mode === 'UNILATERAL' && context.actor.entity_id !== input.subjectEntityId) {
    throw domainError('UNILATERAL_ACTOR_MISMATCH', 'a unilateral relationship can only be declared by its subject', 403);
  }

  const actionAt = await actionTime(client, context.actionId);
  const provenance = mode === 'UNILATERAL'
    ? actorProvenance({
      sourceKind: rule.sourceKind,
      recordType: rule.recordType,
      actionId: context.actionId,
      occurredAt: actionAt.iso,
      participantRole: 'SUBJECT',
    })
    : derivedProvenance(rule, input.sourceRef);

  await client.query(
    `INSERT INTO social.relationships
      (relationship_id,world_id,subject_entity_id,object_entity_id,relationship_type,relationship_mode)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [relationshipId, input.worldId, input.subjectEntityId, input.objectEntityId, relationshipType, mode],
  );

  const version = await insertVersion(client, {
    relationshipId,
    worldId: input.worldId,
    version: 1,
    ...state,
    changedAt: actionAt.exact,
    ...period,
    provenance,
    actorEntityId: context.actor.entity_id,
    actionId: context.actionId,
  });
  return { relationshipId, mode, version };
}

export async function appendRelationshipVersion(client, input, context) {
  const header = await loadHeader(client, input.worldId, input.relationshipId);
  if (header.relationship_mode === 'MUTUAL') {
    throw domainError('MUTUAL_CONFIRMATIONS_REQUIRED', 'mutual relationship revisions require a new two-party proposal', 409);
  }
  if (header.relationship_mode === 'UNILATERAL' && context.actor.entity_id !== header.subject_entity_id) {
    throw domainError('UNILATERAL_ACTOR_MISMATCH', 'only the declaring subject can revise a unilateral relationship', 403);
  }

  const { rule } = requireRelationshipType(header.relationship_type);
  const state = requireState(input.status, input.disputeStatus ?? 'NONE');
  const period = requirePeriod(state.status, input.validFrom, input.validUntil);
  const actionAt = await actionTime(client, context.actionId);
  const provenance = header.relationship_mode === 'UNILATERAL'
    ? actorProvenance({
      sourceKind: rule.sourceKind,
      recordType: rule.recordType,
      actionId: context.actionId,
      occurredAt: actionAt.iso,
      participantRole: 'SUBJECT',
    })
    : derivedProvenance(rule, input.sourceRef);
  const versionNumber = await nextVersion(client, input.relationshipId);
  const version = await insertVersion(client, {
    relationshipId: input.relationshipId,
    worldId: input.worldId,
    version: versionNumber,
    ...state,
    changedAt: actionAt.exact,
    ...period,
    provenance,
    actorEntityId: context.actor.entity_id,
    actionId: context.actionId,
  });
  return { relationshipId: input.relationshipId, mode: header.relationship_mode, version };
}

export async function proposeMutualRelationship(client, input, context) {
  const { relationshipType, rule } = requireRelationshipType(input.relationshipType);
  if (rule.mode !== 'MUTUAL') throw domainError('RELATIONSHIP_MODE_MISMATCH', `${relationshipType} is not a mutual relationship type`, 409);
  const state = requireState(input.status ?? 'ACTIVE', input.disputeStatus ?? 'NONE');
  const period = requirePeriod(state.status, input.validFrom, input.validUntil);
  const [subjectEntityId, objectEntityId] = canonicalMutualPair(input.subjectEntityId, input.objectEntityId);
  if (![subjectEntityId, objectEntityId].includes(context.actor.entity_id)) {
    throw domainError('MUTUAL_PROPOSER_NOT_PARTY', 'only a relationship party can propose a mutual relationship', 403);
  }

  let relationshipId = input.relationshipId ?? crypto.randomUUID();
  let relationshipVersion = 1;
  if (input.relationshipId) {
    const header = await loadHeader(client, input.worldId, input.relationshipId);
    if (header.relationship_mode !== 'MUTUAL'
        || header.subject_entity_id !== subjectEntityId
        || header.object_entity_id !== objectEntityId
        || header.relationship_type !== relationshipType) {
      throw domainError('RELATIONSHIP_HEADER_MISMATCH', 'mutual proposal does not match the existing relationship header', 409);
    }
    relationshipVersion = await nextVersion(client, input.relationshipId);
    relationshipId = header.relationship_id;
  }

  const actionAt = await actionTime(client, context.actionId);
  const proposal = await client.query(
    `INSERT INTO social.mutual_relationship_proposals
      (world_id,relationship_id,relationship_version,subject_entity_id,object_entity_id,relationship_type,status,dispute_status,changed_at,valid_from,valid_until,proposed_by_entity_id,proposal_action_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING proposal_id,world_id,relationship_id,relationship_version,subject_entity_id,object_entity_id,relationship_type,status,dispute_status,changed_at,valid_from,valid_until,proposed_by_entity_id,proposal_action_id,created_at`,
    [input.worldId, relationshipId, relationshipVersion, subjectEntityId, objectEntityId, relationshipType, state.status, state.disputeStatus, actionAt.exact, period.validFrom, period.validUntil, context.actor.entity_id, context.actionId],
  );
  return proposal.rows[0];
}

export async function confirmMutualRelationship(client, input, context) {
  const proposalResult = await client.query(
    `SELECT proposal_id,world_id,relationship_id,relationship_version,subject_entity_id,object_entity_id,relationship_type,status,dispute_status,changed_at,valid_from,valid_until,proposed_by_entity_id,proposal_action_id
       FROM social.mutual_relationship_proposals
      WHERE proposal_id=$1 AND world_id=$2`,
    [input.proposalId, input.worldId],
  );
  if (proposalResult.rowCount !== 1) throw domainError('MUTUAL_PROPOSAL_NOT_FOUND', 'mutual relationship proposal not found', 404);
  const proposal = proposalResult.rows[0];
  if (![proposal.subject_entity_id, proposal.object_entity_id].includes(context.actor.entity_id)) {
    throw domainError('MUTUAL_CONFIRMER_NOT_PARTY', 'only a relationship party can confirm the proposal', 403);
  }
  if (context.actor.entity_id === proposal.proposed_by_entity_id) {
    throw domainError('MUTUAL_SECOND_PARTY_REQUIRED', 'the proposer cannot supply the counterparty confirmation', 409);
  }

  const confirmationAt = await actionTime(client, context.actionId);
  const proposerAt = await actionTime(client, proposal.proposal_action_id);
  const proposerRole = proposal.proposed_by_entity_id === proposal.subject_entity_id ? 'SUBJECT' : 'OBJECT';
  const confirmerRole = context.actor.entity_id === proposal.subject_entity_id ? 'SUBJECT' : 'OBJECT';
  const provenance = {
    source_kind: 'MUTUAL_CONFIRMATION',
    records: [
      {
        record_type: 'CONFIRMATION',
        record_id: proposal.proposal_action_id,
        participant_role: proposerRole,
        occurred_at: proposerAt.iso,
      },
      {
        record_type: 'CONFIRMATION',
        record_id: context.actionId,
        participant_role: confirmerRole,
        occurred_at: confirmationAt.iso,
      },
    ],
  };

  await client.query(
    `INSERT INTO social.mutual_relationship_confirmations
      (proposal_id,world_id,confirmer_entity_id,confirmation_action_id)
     VALUES ($1,$2,$3,$4)`,
    [proposal.proposal_id, proposal.world_id, context.actor.entity_id, context.actionId],
  );

  if (proposal.relationship_version === 1) {
    await client.query(
      `INSERT INTO social.relationships
        (relationship_id,world_id,subject_entity_id,object_entity_id,relationship_type,relationship_mode)
       VALUES ($1,$2,$3,$4,$5,'MUTUAL')`,
      [proposal.relationship_id, proposal.world_id, proposal.subject_entity_id, proposal.object_entity_id, proposal.relationship_type],
    );
  } else {
    const header = await loadHeader(client, proposal.world_id, proposal.relationship_id);
    if (header.relationship_mode !== 'MUTUAL'
        || header.subject_entity_id !== proposal.subject_entity_id
        || header.object_entity_id !== proposal.object_entity_id
        || header.relationship_type !== proposal.relationship_type) {
      throw domainError('RELATIONSHIP_HEADER_MISMATCH', 'mutual proposal no longer matches the relationship header', 409);
    }
  }

  const version = await insertVersion(client, {
    relationshipId: proposal.relationship_id,
    worldId: proposal.world_id,
    version: proposal.relationship_version,
    status: proposal.status,
    disputeStatus: proposal.dispute_status,
    changedAt: confirmationAt.exact,
    validFrom: proposal.valid_from,
    validUntil: proposal.valid_until,
    provenance,
    mutualProposalId: proposal.proposal_id,
    actorEntityId: context.actor.entity_id,
    actionId: context.actionId,
  });
  return { relationshipId: proposal.relationship_id, mode: 'MUTUAL', version };
}

export async function getRelationshipHistory(client, { worldId, relationshipId }) {
  const header = await loadHeader(client, worldId, relationshipId);
  const versions = await client.query(
    `SELECT relationship_id,version,world_id,status,dispute_status,changed_at,valid_from,valid_until,provenance,mutual_proposal_id,recorded_by_entity_id,recorded_action_id,recorded_at
       FROM social.relationship_versions
      WHERE world_id=$1 AND relationship_id=$2
      ORDER BY version ASC`,
    [worldId, relationshipId],
  );
  return { ...header, versions: versions.rows };
}

export function toRelationshipContract(history, version = history?.versions?.at(-1)) {
  if (!history || !version) throw domainError('RELATIONSHIP_VERSION_REQUIRED', 'relationship history and version are required');
  return {
    relationship_id: history.relationship_id,
    world_id: history.world_id,
    subject_entity_id: history.subject_entity_id,
    object_entity_id: history.object_entity_id,
    relationship_type: history.relationship_type,
    state: {
      status: version.status,
      dispute_status: version.dispute_status,
      changed_at: iso(version.changed_at),
    },
    time: {
      created_at: iso(history.created_at),
      valid_from: iso(version.valid_from),
      valid_until: iso(version.valid_until),
    },
    provenance: version.provenance,
  };
}
