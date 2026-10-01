import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertWorldId(worldId) {
  if (typeof worldId !== 'string' || !UUID_PATTERN.test(worldId)) {
    throw Object.assign(new Error('fixture worldId must be a valid UUID'), {
      code: 'INVALID_FIXTURE_WORLD',
    });
  }
}

function assertFixtureEntity(entity, worldId, entityType) {
  if (!UUID_PATTERN.test(entity.entity_id)) {
    throw new Error(`fixture ${entityType} entity_id is not a valid UUID`);
  }
  if (entity.world_id !== worldId) {
    throw new Error(`fixture ${entityType} belongs to an unexpected world`);
  }
  if (entity.entity_type !== entityType || entity.identity_status !== 'ACTIVE') {
    throw new Error(`fixture ${entityType} is not an active ${entityType} Entity`);
  }
}

export function isFixtureUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function createEntityFixtures(pool, { worldId = randomUUID() } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('createEntityFixtures requires a pg-compatible pool');
  }
  assertWorldId(worldId);

  const fixtureKey = randomUUID();
  const created = await withTransaction(pool, async (client) => {
    const system = await createEntity(client, {
      worldId,
      entityType: 'SYSTEM',
      displayId: `system-${fixtureKey}`,
      name: 'Test System',
      origin: 'TEST_FIXTURE',
    });

    const createOwnedEntity = (entityType, displayName) => createEntity(client, {
      worldId,
      entityType,
      displayId: `${entityType.toLowerCase()}-${fixtureKey}`,
      name: displayName,
      createdBy: system.entity_id,
      origin: 'TEST_FIXTURE',
    }, { actorEntityId: system.entity_id });

    const human = await createOwnedEntity('HUMAN', 'Test Human');
    const agent = await createOwnedEntity('AGENT', 'Test Agent');
    const company = await createOwnedEntity('COMPANY', 'Test Company');
    return { system, human, agent, company };
  });

  for (const [key, entityType] of [
    ['system', 'SYSTEM'],
    ['human', 'HUMAN'],
    ['agent', 'AGENT'],
    ['company', 'COMPANY'],
  ]) {
    assertFixtureEntity(created[key], worldId, entityType);
  }

  return {
    worldId,
    actorEntityId: created.system.entity_id,
    world: { world_id: worldId },
    actor: { world_id: worldId, entity_id: created.system.entity_id },
    system: { ...created.system },
    human: { ...created.human },
    agent: { ...created.agent },
    company: { ...created.company },
  };
}
