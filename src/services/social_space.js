import { appendEvent } from './core.js';

const SPACE_TYPES = new Set(['PROJECT', 'ACTIVITY']);
const VISIBILITIES = new Set(['PUBLIC', 'MEMBERS']);
const MEMBER_ROLES = new Set(['EDITOR', 'MEMBER', 'OBSERVER']);
const RELATION_KINDS = new Set(['COLLECTION', 'REFERENCE', 'DELIVERABLE']);

function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function validateText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw failure('INVALID_SPACE_METADATA', `${name} must be a non-empty string up to ${maxLength} characters`, 400);
  }
}

function validateTopic(value) {
  if (value !== null && value !== undefined && (typeof value !== 'string' || value.length > 280)) {
    throw failure('INVALID_SPACE_METADATA', 'topic must be null or a string up to 280 characters', 400);
  }
}

async function assertActiveEntity(client, worldId, entityId) {
  const result = await client.query(
    `SELECT entity_id FROM core.entities WHERE world_id=$1 AND entity_id=$2 AND identity_status='ACTIVE'`,
    [worldId, entityId],
  );
  if (result.rowCount !== 1) throw failure('ENTITY_NOT_ACTIVE', 'entity is not active in this world', 409);
}

async function lockSpace(client, worldId, spaceId) {
  const result = await client.query(
    `SELECT space_id, world_id, space_type, name, topic, owner_entity_id, visibility, lifecycle_status, version, created_at, updated_at
       FROM social.spaces WHERE world_id=$1 AND space_id=$2 FOR UPDATE`,
    [worldId, spaceId],
  );
  if (result.rowCount !== 1) throw failure('SPACE_NOT_FOUND', 'space does not exist', 404);
  return result.rows[0];
}

function assertMutable(space) {
  if (space.lifecycle_status !== 'ACTIVE') throw failure('SPACE_NOT_ACTIVE', 'space is not active', 409);
}

function assertExpectedVersion(space, expectedVersion) {
  if (expectedVersion === null || expectedVersion === undefined) return;
  if (String(space.version) !== String(expectedVersion)) {
    throw failure('SPACE_VERSION_CONFLICT', `expected space version ${expectedVersion}, current version is ${space.version}`, 409);
  }
}

async function bumpSpaceVersion(client, worldId, spaceId) {
  const result = await client.query(
    `UPDATE social.spaces SET version=version+1, updated_at=now()
      WHERE world_id=$1 AND space_id=$2 RETURNING version, updated_at`,
    [worldId, spaceId],
  );
  return result.rows[0];
}

export async function createSpace(client, {
  worldId,
  spaceType,
  name,
  topic = null,
  ownerEntityId,
  visibility = 'PUBLIC',
  actorEntityId = ownerEntityId,
  actionId = null,
}) {
  if (!SPACE_TYPES.has(spaceType)) throw failure('INVALID_SPACE_TYPE', 'spaceType must be PROJECT or ACTIVITY', 400);
  if (!VISIBILITIES.has(visibility)) throw failure('INVALID_SPACE_VISIBILITY', 'invalid space visibility', 400);
  validateText(name, 'name', 200);
  validateTopic(topic);
  await assertActiveEntity(client, worldId, ownerEntityId);

  const inserted = await client.query(
    `INSERT INTO social.spaces (world_id, space_type, name, topic, owner_entity_id, visibility)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING space_id, world_id, space_type, name, topic, owner_entity_id, visibility, lifecycle_status, version, created_at, updated_at`,
    [worldId, spaceType, name.trim(), topic, ownerEntityId, visibility],
  );
  const space = inserted.rows[0];
  const membership = await client.query(
    `INSERT INTO social.space_memberships (world_id, space_id, member_entity_id, role)
     VALUES ($1,$2,$3,'OWNER')
     RETURNING membership_id, member_entity_id, role, joined_at, left_at, version`,
    [worldId, space.space_id, ownerEntityId],
  );
  await appendEvent(client, {
    worldId,
    aggregateType: 'SPACE',
    aggregateId: space.space_id,
    eventType: 'SPACE_CREATED',
    actorEntityId,
    actionId,
    payload: { spaceType, visibility },
  });
  return { ...space, ownerMembership: membership.rows[0] };
}

export async function updateSpaceMetadata(client, {
  worldId,
  spaceId,
  expectedVersion,
  name,
  topic,
  visibility,
  actorEntityId,
  actionId = null,
}) {
  const space = await lockSpace(client, worldId, spaceId);
  assertMutable(space);
  if (expectedVersion === null || expectedVersion === undefined) {
    throw failure('EXPECTED_VERSION_REQUIRED', 'expectedVersion is required for space metadata updates', 400);
  }
  assertExpectedVersion(space, expectedVersion);

  const sets = [];
  const values = [worldId, spaceId];
  if (name !== undefined) {
    validateText(name, 'name', 200);
    values.push(name.trim());
    sets.push(`name=$${values.length}`);
  }
  if (topic !== undefined) {
    validateTopic(topic);
    values.push(topic);
    sets.push(`topic=$${values.length}`);
  }
  if (visibility !== undefined) {
    if (!VISIBILITIES.has(visibility)) throw failure('INVALID_SPACE_VISIBILITY', 'invalid space visibility', 400);
    values.push(visibility);
    sets.push(`visibility=$${values.length}`);
  }
  if (sets.length === 0) return { ...space, unchanged: true };

  const updated = await client.query(
    `UPDATE social.spaces SET ${sets.join(', ')}, version=version+1, updated_at=now()
      WHERE world_id=$1 AND space_id=$2
      RETURNING space_id, world_id, space_type, name, topic, owner_entity_id, visibility, lifecycle_status, version, created_at, updated_at`,
    values,
  );
  await appendEvent(client, {
    worldId,
    aggregateType: 'SPACE',
    aggregateId: spaceId,
    eventType: 'SPACE_METADATA_UPDATED',
    actorEntityId,
    actionId,
    payload: { previousVersion: String(space.version), currentVersion: String(updated.rows[0].version) },
  });
  return updated.rows[0];
}

export async function joinSpace(client, {
  worldId,
  spaceId,
  memberEntityId,
  role = 'MEMBER',
  expectedVersion = null,
  actorEntityId,
  actionId = null,
}) {
  if (!MEMBER_ROLES.has(role)) throw failure('INVALID_SPACE_ROLE', 'join role must be EDITOR, MEMBER, or OBSERVER', 400);
  const space = await lockSpace(client, worldId, spaceId);
  assertMutable(space);
  await assertActiveEntity(client, worldId, memberEntityId);

  const active = await client.query(
    `SELECT membership_id, member_entity_id, role, joined_at, left_at, version
       FROM social.space_memberships
      WHERE world_id=$1 AND space_id=$2 AND member_entity_id=$3 AND left_at IS NULL`,
    [worldId, spaceId, memberEntityId],
  );
  if (active.rowCount === 1) {
    if (active.rows[0].role !== role && active.rows[0].role !== 'OWNER') {
      throw failure('MEMBERSHIP_ROLE_CONFLICT', 'entity is already an active member with a different role', 409);
    }
    return { membership: active.rows[0], alreadyMember: true, spaceVersion: String(space.version) };
  }

  assertExpectedVersion(space, expectedVersion);
  const inserted = await client.query(
    `INSERT INTO social.space_memberships (world_id, space_id, member_entity_id, role)
     VALUES ($1,$2,$3,$4)
     RETURNING membership_id, member_entity_id, role, joined_at, left_at, version`,
    [worldId, spaceId, memberEntityId, role],
  );
  const bumped = await bumpSpaceVersion(client, worldId, spaceId);
  await appendEvent(client, {
    worldId,
    aggregateType: 'SPACE',
    aggregateId: spaceId,
    eventType: 'SPACE_MEMBER_JOINED',
    actorEntityId,
    actionId,
    payload: { memberEntityId, role },
  });
  return { membership: inserted.rows[0], alreadyMember: false, spaceVersion: String(bumped.version) };
}

export async function leaveSpace(client, {
  worldId,
  spaceId,
  memberEntityId,
  expectedVersion = null,
  actorEntityId,
  actionId = null,
}) {
  const space = await lockSpace(client, worldId, spaceId);
  assertMutable(space);
  if (memberEntityId === space.owner_entity_id) throw failure('SPACE_OWNER_CANNOT_LEAVE', 'space owner cannot leave an active space', 409);

  const active = await client.query(
    `SELECT membership_id, member_entity_id, role, joined_at, left_at, version
       FROM social.space_memberships
      WHERE world_id=$1 AND space_id=$2 AND member_entity_id=$3 AND left_at IS NULL
      FOR UPDATE`,
    [worldId, spaceId, memberEntityId],
  );
  if (active.rowCount === 0) {
    const previous = await client.query(
      `SELECT membership_id, member_entity_id, role, joined_at, left_at, version
         FROM social.space_memberships
        WHERE world_id=$1 AND space_id=$2 AND member_entity_id=$3
        ORDER BY joined_at DESC, membership_id DESC LIMIT 1`,
      [worldId, spaceId, memberEntityId],
    );
    return { membership: previous.rows[0] ?? null, alreadyLeft: true, spaceVersion: String(space.version) };
  }

  assertExpectedVersion(space, expectedVersion);
  const updated = await client.query(
    `UPDATE social.space_memberships SET left_at=now(), version=version+1
      WHERE membership_id=$1
      RETURNING membership_id, member_entity_id, role, joined_at, left_at, version`,
    [active.rows[0].membership_id],
  );
  const bumped = await bumpSpaceVersion(client, worldId, spaceId);
  await appendEvent(client, {
    worldId,
    aggregateType: 'SPACE',
    aggregateId: spaceId,
    eventType: 'SPACE_MEMBER_LEFT',
    actorEntityId,
    actionId,
    payload: { memberEntityId },
  });
  return { membership: updated.rows[0], alreadyLeft: false, spaceVersion: String(bumped.version) };
}

export async function attachObjectToSpace(client, {
  worldId,
  spaceId,
  worldObjectId,
  relationKind = 'COLLECTION',
  sourceObjectVersion = null,
  expectedVersion = null,
  actorEntityId,
  actionId = null,
}) {
  if (!RELATION_KINDS.has(relationKind)) throw failure('INVALID_SPACE_OBJECT_RELATION', 'invalid relation kind', 400);
  if (sourceObjectVersion !== null && (!Number.isInteger(Number(sourceObjectVersion)) || Number(sourceObjectVersion) <= 0)) {
    throw failure('INVALID_OBJECT_VERSION', 'sourceObjectVersion must be a positive integer or null', 400);
  }
  const space = await lockSpace(client, worldId, spaceId);
  assertMutable(space);
  await assertActiveEntity(client, worldId, actorEntityId);

  const active = await client.query(
    `SELECT relation_id, object_authority, world_object_id, relation_kind, source_object_version, added_by_entity_id, added_at, removed_at, version
       FROM social.space_object_relations
      WHERE world_id=$1 AND space_id=$2 AND world_object_id=$3 AND removed_at IS NULL`,
    [worldId, spaceId, worldObjectId],
  );
  if (active.rowCount === 1) {
    const row = active.rows[0];
    const sameVersion = String(row.source_object_version ?? '') === String(sourceObjectVersion ?? '');
    if (row.relation_kind !== relationKind || !sameVersion) {
      throw failure('SPACE_OBJECT_RELATION_CONFLICT', 'object is already attached with different relation metadata', 409);
    }
    return { relation: row, alreadyAttached: true, spaceVersion: String(space.version) };
  }

  assertExpectedVersion(space, expectedVersion);
  const inserted = await client.query(
    `INSERT INTO social.space_object_relations
      (world_id, space_id, world_object_id, relation_kind, source_object_version, added_by_entity_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING relation_id, object_authority, world_object_id, relation_kind, source_object_version, added_by_entity_id, added_at, removed_at, version`,
    [worldId, spaceId, worldObjectId, relationKind, sourceObjectVersion, actorEntityId],
  );
  const bumped = await bumpSpaceVersion(client, worldId, spaceId);
  await appendEvent(client, {
    worldId,
    aggregateType: 'SPACE',
    aggregateId: spaceId,
    eventType: 'SPACE_OBJECT_ATTACHED',
    actorEntityId,
    actionId,
    payload: { worldObjectId, relationKind, sourceObjectVersion },
  });
  return { relation: inserted.rows[0], alreadyAttached: false, spaceVersion: String(bumped.version) };
}

export async function detachObjectFromSpace(client, {
  worldId,
  spaceId,
  worldObjectId,
  expectedVersion = null,
  actorEntityId,
  actionId = null,
}) {
  const space = await lockSpace(client, worldId, spaceId);
  assertMutable(space);
  const active = await client.query(
    `SELECT relation_id, object_authority, world_object_id, relation_kind, source_object_version, added_by_entity_id, added_at, removed_at, version
       FROM social.space_object_relations
      WHERE world_id=$1 AND space_id=$2 AND world_object_id=$3 AND removed_at IS NULL
      FOR UPDATE`,
    [worldId, spaceId, worldObjectId],
  );
  if (active.rowCount === 0) return { relation: null, alreadyDetached: true, spaceVersion: String(space.version) };

  assertExpectedVersion(space, expectedVersion);
  const updated = await client.query(
    `UPDATE social.space_object_relations SET removed_at=now(), version=version+1
      WHERE relation_id=$1
      RETURNING relation_id, object_authority, world_object_id, relation_kind, source_object_version, added_by_entity_id, added_at, removed_at, version`,
    [active.rows[0].relation_id],
  );
  const bumped = await bumpSpaceVersion(client, worldId, spaceId);
  await appendEvent(client, {
    worldId,
    aggregateType: 'SPACE',
    aggregateId: spaceId,
    eventType: 'SPACE_OBJECT_DETACHED',
    actorEntityId,
    actionId,
    payload: { worldObjectId },
  });
  return { relation: updated.rows[0], alreadyDetached: false, spaceVersion: String(bumped.version) };
}
