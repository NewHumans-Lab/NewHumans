import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/db.js';
import { createEntityFixtures, isFixtureUuid } from '../fixtures/entities.js';

const pool = createPool();

async function reset() {
  await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE');
}

test.beforeEach(reset);
test.after(async () => {
  await reset();
  await pool.end();
});

test('standard fixtures are valid UUID-backed entities in one legal world with a legal SYSTEM actor', async () => {
  const fixtures = await createEntityFixtures(pool);
  const entities = [fixtures.system, fixtures.human, fixtures.agent, fixtures.company];

  assert.equal(isFixtureUuid(fixtures.worldId), true);
  assert.deepEqual(fixtures.world, { world_id: fixtures.worldId });
  assert.deepEqual(fixtures.actor, {
    world_id: fixtures.worldId,
    entity_id: fixtures.system.entity_id,
  });
  assert.equal(fixtures.actorEntityId, fixtures.system.entity_id);

  assert.deepEqual(entities.map((entity) => entity.entity_type), ['SYSTEM', 'HUMAN', 'AGENT', 'COMPANY']);
  for (const entity of entities) {
    assert.equal(isFixtureUuid(entity.entity_id), true);
    assert.equal(entity.world_id, fixtures.worldId);
    assert.equal(entity.identity_status, 'ACTIVE');
  }

  const stored = await pool.query(`
    SELECT entity_id, world_id, entity_type, created_by, identity_status
      FROM core.entities
     WHERE world_id = $1
     ORDER BY entity_type, entity_id
  `, [fixtures.worldId]);
  assert.equal(stored.rowCount, 4);

  const byType = Object.fromEntries(stored.rows.map((row) => [row.entity_type, row]));
  assert.equal(byType.SYSTEM.created_by, null);
  for (const entityType of ['HUMAN', 'AGENT', 'COMPANY']) {
    assert.equal(byType[entityType].created_by, fixtures.system.entity_id);
    assert.equal(byType[entityType].world_id, fixtures.worldId);
    assert.equal(byType[entityType].identity_status, 'ACTIVE');
  }
});

test('parallel fixture generation does not collide, including inside the same world', async () => {
  const sharedWorldId = randomUUID();
  const sets = await Promise.all(
    Array.from({ length: 24 }, () => createEntityFixtures(pool, { worldId: sharedWorldId })),
  );

  const entities = sets.flatMap((fixtures) => [
    fixtures.system,
    fixtures.human,
    fixtures.agent,
    fixtures.company,
  ]);
  const entityIds = entities.map((entity) => entity.entity_id);
  const displayIds = entities.map((entity) => entity.display_id);

  assert.equal(new Set(entityIds).size, entityIds.length);
  assert.equal(new Set(displayIds).size, displayIds.length);
  assert.equal(sets.every((fixtures) => fixtures.worldId === sharedWorldId), true);
  assert.equal(sets.every((fixtures) => fixtures.actorEntityId === fixtures.system.entity_id), true);

  const stored = await pool.query(`
    SELECT count(*)::int AS count,
           count(DISTINCT entity_id)::int AS entity_ids,
           count(DISTINCT display_id)::int AS display_ids
      FROM core.entities
     WHERE world_id = $1
  `, [sharedWorldId]);
  assert.equal(stored.rows[0].count, entities.length);
  assert.equal(stored.rows[0].entity_ids, entities.length);
  assert.equal(stored.rows[0].display_ids, entities.length);
});

test('fixture calls do not share mutable state', async () => {
  const sharedWorldId = randomUUID();
  const [left, right] = await Promise.all([
    createEntityFixtures(pool, { worldId: sharedWorldId }),
    createEntityFixtures(pool, { worldId: sharedWorldId }),
  ]);

  assert.notStrictEqual(left.world, right.world);
  assert.notStrictEqual(left.actor, right.actor);
  assert.notStrictEqual(left.system, right.system);
  assert.notStrictEqual(left.human, right.human);
  assert.notStrictEqual(left.agent, right.agent);
  assert.notStrictEqual(left.company, right.company);

  const rightAgentName = right.agent.name;
  const rightActorId = right.actor.entity_id;
  left.world.world_id = randomUUID();
  left.actor.entity_id = randomUUID();
  left.agent.name = 'mutated-local-agent';

  assert.equal(right.world.world_id, sharedWorldId);
  assert.equal(right.actor.entity_id, rightActorId);
  assert.equal(right.agent.name, rightAgentName);
  assert.equal(right.worldId, sharedWorldId);
  assert.equal(right.actorEntityId, right.system.entity_id);
});

test('fixture generation rejects invalid worlds before writing entities', async () => {
  for (const worldId of ['', 'test-world', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(
      () => createEntityFixtures(pool, { worldId }),
      (error) => error?.code === 'INVALID_FIXTURE_WORLD',
    );
  }
  const stored = await pool.query('SELECT count(*)::int AS count FROM core.entities');
  assert.equal(stored.rows[0].count, 0);
});
