import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import {
  attachObjectToSpace,
  createSpace,
  detachObjectFromSpace,
  joinSpace,
  leaveSpace,
  updateSpaceMetadata,
} from '../../src/services/social_space.js';

const pool = createPool();
const world = 'm04-space-world';
let system;

async function reset() {
  await pool.query(`TRUNCATE
    social.space_object_relations,
    social.space_memberships,
    social.spaces,
    core.consumer_receipts,
    core.outbox,
    core.life_events,
    economy.activity_fees,
    economy.activity_subjects,
    economy.reservations,
    economy.postings,
    economy.journals,
    economy.wallets,
    core.actions,
    core.capability_grants,
    core.entities
    RESTART IDENTITY CASCADE`);
  system = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world,
    entityType: 'SYSTEM',
    displayId: 'system',
    name: 'System',
  }));
}

async function entity(type, name, entityWorld = world) {
  return withTransaction(pool, (client) => createEntity(client, {
    worldId: entityWorld,
    entityType: type,
    displayId: `${name}-${crypto.randomUUID()}`,
    name,
    createdBy: entityWorld === world ? system.entity_id : null,
  }, entityWorld === world ? { actorEntityId: system.entity_id } : {}));
}

async function makeSpace(owner, suffix = crypto.randomUUID()) {
  const commandInput = {
    worldId: world,
    actorEntityId: owner.entity_id,
    actionType: 'social.create_space',
    idempotencyKey: `space-${suffix}`,
    payload: { spaceType: 'PROJECT', name: `Project ${suffix}`, topic: 'coordination only' },
  };
  return runCommand(pool, commandInput, (client, context) => createSpace(client, {
    worldId: world,
    spaceType: 'PROJECT',
    name: `Project ${suffix}`,
    topic: 'coordination only',
    ownerEntityId: owner.entity_id,
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
}

function command(actor, actionType, idempotencyKey, payload, execute) {
  return runCommand(pool, {
    worldId: world,
    actorEntityId: actor.entity_id,
    actionType,
    idempotencyKey,
    payload,
  }, execute);
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('space creation seeds owner membership and Space tables cannot become a second knowledge payload store', async () => {
  const owner = await entity('AGENT', 'owner');
  const created = await makeSpace(owner, 'authority');
  const space = created.result;
  assert.equal(space.version, '1');
  assert.equal(space.ownerMembership.role, 'OWNER');

  const membershipCount = await pool.query(
    `SELECT count(*)::int AS n FROM social.space_memberships
      WHERE world_id=$1 AND space_id=$2 AND member_entity_id=$3 AND left_at IS NULL`,
    [world, space.space_id, owner.entity_id],
  );
  assert.equal(membershipCount.rows[0].n, 1);

  const forbiddenColumns = await pool.query(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='social'
       AND table_name IN ('spaces','space_memberships','space_object_relations')
       AND (
         column_name ~* '(content|payload|knowledge|memory|embedding|secret|document_body|message_body)'
         OR data_type IN ('json','jsonb','bytea','tsvector')
       )`);
  assert.equal(forbiddenColumns.rowCount, 0);

  const comment = await pool.query(`SELECT obj_description('social.space_object_relations'::regclass) AS note`);
  assert.match(comment.rows[0].note, /Reference-only relation/);
});

test('repeat join and repeat leave are no-ops, while rejoin creates preserved membership history', async () => {
  const owner = await entity('AGENT', 'owner');
  const member = await entity('HUMAN', 'member');
  const space = (await makeSpace(owner, 'membership')).result;

  const joinPayload = { spaceId: space.space_id, memberEntityId: member.entity_id, role: 'MEMBER', expectedVersion: '1' };
  const firstJoin = await command(member, 'social.join_space', 'join-1', joinPayload, (client, context) => joinSpace(client, {
    worldId: world,
    ...joinPayload,
    actorEntityId: member.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(firstJoin.result.alreadyMember, false);
  assert.equal(firstJoin.result.spaceVersion, '2');

  const replay = await command(member, 'social.join_space', 'join-1', joinPayload, (client, context) => joinSpace(client, {
    worldId: world,
    ...joinPayload,
    actorEntityId: member.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(replay.replayed, true);

  const duplicate = await command(member, 'social.join_space', 'join-2', { ...joinPayload, expectedVersion: '2' }, (client, context) => joinSpace(client, {
    worldId: world,
    ...joinPayload,
    expectedVersion: '2',
    actorEntityId: member.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(duplicate.result.alreadyMember, true);
  assert.equal(duplicate.result.spaceVersion, '2');

  const leavePayload = { spaceId: space.space_id, memberEntityId: member.entity_id, expectedVersion: '2' };
  const firstLeave = await command(member, 'social.leave_space', 'leave-1', leavePayload, (client, context) => leaveSpace(client, {
    worldId: world,
    ...leavePayload,
    actorEntityId: member.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(firstLeave.result.alreadyLeft, false);
  assert.equal(firstLeave.result.spaceVersion, '3');

  const repeatLeave = await command(member, 'social.leave_space', 'leave-2', { ...leavePayload, expectedVersion: '3' }, (client, context) => leaveSpace(client, {
    worldId: world,
    ...leavePayload,
    expectedVersion: '3',
    actorEntityId: member.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(repeatLeave.result.alreadyLeft, true);
  assert.equal(repeatLeave.result.spaceVersion, '3');

  const rejoin = await command(member, 'social.join_space', 'join-3', { ...joinPayload, expectedVersion: '3' }, (client, context) => joinSpace(client, {
    worldId: world,
    ...joinPayload,
    expectedVersion: '3',
    actorEntityId: member.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(rejoin.result.alreadyMember, false);
  assert.equal(rejoin.result.spaceVersion, '4');

  const history = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE left_at IS NULL)::int AS active
       FROM social.space_memberships WHERE world_id=$1 AND space_id=$2 AND member_entity_id=$3`,
    [world, space.space_id, member.entity_id],
  );
  assert.deepEqual(history.rows[0], { total: 2, active: 1 });
});

test('object association is reference-only, replay-safe, detachable, and preserves relation history', async () => {
  const owner = await entity('AGENT', 'owner');
  const space = (await makeSpace(owner, 'objects')).result;
  const worldObjectId = crypto.randomUUID();

  const attachPayload = {
    spaceId: space.space_id,
    worldObjectId,
    relationKind: 'REFERENCE',
    sourceObjectVersion: 7,
    expectedVersion: '1',
  };
  const first = await command(owner, 'social.attach_space_object', 'attach-1', attachPayload, (client, context) => attachObjectToSpace(client, {
    worldId: world,
    ...attachPayload,
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(first.result.alreadyAttached, false);
  assert.equal(first.result.spaceVersion, '2');
  assert.equal(first.result.relation.object_authority, 'M04_WORLD_OBJECT');
  assert.equal(first.result.relation.source_object_version, '7');

  const replay = await command(owner, 'social.attach_space_object', 'attach-1', attachPayload, (client, context) => attachObjectToSpace(client, {
    worldId: world,
    ...attachPayload,
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(replay.replayed, true);

  const duplicate = await command(owner, 'social.attach_space_object', 'attach-2', { ...attachPayload, expectedVersion: '2' }, (client, context) => attachObjectToSpace(client, {
    worldId: world,
    ...attachPayload,
    expectedVersion: '2',
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(duplicate.result.alreadyAttached, true);
  assert.equal(duplicate.result.spaceVersion, '2');

  const detached = await command(owner, 'social.detach_space_object', 'detach-object', { spaceId: space.space_id, worldObjectId, expectedVersion: '2' }, (client, context) => detachObjectFromSpace(client, {
    worldId: world,
    spaceId: space.space_id,
    worldObjectId,
    expectedVersion: '2',
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(detached.result.alreadyDetached, false);
  assert.equal(detached.result.spaceVersion, '3');

  const reattached = await command(owner, 'social.attach_space_object', 'attach-3', { ...attachPayload, sourceObjectVersion: 8, expectedVersion: '3' }, (client, context) => attachObjectToSpace(client, {
    worldId: world,
    ...attachPayload,
    sourceObjectVersion: 8,
    expectedVersion: '3',
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(reattached.result.spaceVersion, '4');

  const history = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE removed_at IS NULL)::int AS active,
            max(source_object_version)::bigint AS newest_version
       FROM social.space_object_relations WHERE world_id=$1 AND space_id=$2 AND world_object_id=$3`,
    [world, space.space_id, worldObjectId],
  );
  assert.deepEqual(history.rows[0], { total: 2, active: 1, newest_version: '8' });
});

test('space expected-version fencing allows only one concurrent mutation and rejects stale metadata writes', async () => {
  const owner = await entity('AGENT', 'owner');
  const memberA = await entity('HUMAN', 'member-a');
  const memberB = await entity('HUMAN', 'member-b');
  const space = (await makeSpace(owner, 'versions')).result;

  const joins = [memberA, memberB].map((member, index) => command(
    member,
    'social.join_space',
    `race-${index}`,
    { spaceId: space.space_id, memberEntityId: member.entity_id, role: 'MEMBER', expectedVersion: '1' },
    (client, context) => joinSpace(client, {
      worldId: world,
      spaceId: space.space_id,
      memberEntityId: member.entity_id,
      role: 'MEMBER',
      expectedVersion: '1',
      actorEntityId: member.entity_id,
      actionId: context.actionId,
    }),
  ));
  const settled = await Promise.allSettled(joins);
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((item) => item.status === 'rejected' && item.reason.code === 'SPACE_VERSION_CONFLICT').length, 1);

  await assert.rejects(
    () => command(owner, 'social.update_space', 'stale-update', { spaceId: space.space_id, expectedVersion: '1', name: 'stale' }, (client, context) => updateSpaceMetadata(client, {
      worldId: world,
      spaceId: space.space_id,
      expectedVersion: '1',
      name: 'stale',
      actorEntityId: owner.entity_id,
      actionId: context.actionId,
    })),
    (error) => error.code === 'SPACE_VERSION_CONFLICT',
  );

  const updated = await command(owner, 'social.update_space', 'current-update', { spaceId: space.space_id, expectedVersion: '2', name: 'Current Name' }, (client, context) => updateSpaceMetadata(client, {
    worldId: world,
    spaceId: space.space_id,
    expectedVersion: '2',
    name: 'Current Name',
    actorEntityId: owner.entity_id,
    actionId: context.actionId,
  }));
  assert.equal(updated.result.version, '3');
  assert.equal(updated.result.name, 'Current Name');
});

test('space membership cannot cross world authority', async () => {
  const owner = await entity('AGENT', 'owner');
  const outsider = await entity('HUMAN', 'outsider', 'other-world');
  const space = (await makeSpace(owner, 'world-boundary')).result;

  await assert.rejects(
    () => command(owner, 'social.join_space', 'cross-world', { spaceId: space.space_id, memberEntityId: outsider.entity_id }, (client, context) => joinSpace(client, {
      worldId: world,
      spaceId: space.space_id,
      memberEntityId: outsider.entity_id,
      actorEntityId: owner.entity_id,
      actionId: context.actionId,
    })),
    (error) => error.code === 'ENTITY_NOT_ACTIVE',
  );
});
