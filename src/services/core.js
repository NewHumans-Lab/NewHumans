import crypto from 'node:crypto';
import { ENTITY_TYPES } from '../shared/constants.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

export async function resolveActor(client, actorEntityId) {
  if (!actorEntityId) throw Object.assign(new Error('x-nh-actor-id is required'), { code: 'UNAUTHENTICATED', status: 401 });
  const result = await client.query('SELECT entity_id, world_id, entity_type, identity_status FROM core.entities WHERE entity_id = $1', [actorEntityId]);
  if (result.rowCount !== 1 || result.rows[0].identity_status !== 'ACTIVE') {
    throw Object.assign(new Error('actor is not an active registered Entity'), { code: 'UNAUTHENTICATED', status: 401 });
  }
  return result.rows[0];
}

export async function appendEvent(client, { worldId, aggregateType, aggregateId, eventType, actorEntityId = null, actionId = null, payload = {} }) {
  const lockKey = `${worldId}:${aggregateType}:${aggregateId}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
  const seq = await client.query(`SELECT COALESCE(MAX(aggregate_seq), 0) + 1 AS next_seq FROM core.life_events WHERE world_id = $1 AND aggregate_type = $2 AND aggregate_id = $3`, [worldId, aggregateType, aggregateId]);
  const inserted = await client.query(`INSERT INTO core.life_events (world_id, aggregate_type, aggregate_id, aggregate_seq, event_type, actor_entity_id, action_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING event_id, aggregate_seq, created_at`, [worldId, aggregateType, aggregateId, seq.rows[0].next_seq, eventType, actorEntityId, actionId, JSON.stringify(payload)]);
  await client.query(`INSERT INTO core.outbox (event_id, topic, payload) VALUES ($1,$2,$3::jsonb)`, [inserted.rows[0].event_id, `nh.${aggregateType.toLowerCase()}.${eventType.toLowerCase()}`, JSON.stringify(payload)]);
  return inserted.rows[0];
}

export async function runCommand(pool, { worldId, actorEntityId, actionType, idempotencyKey, payload }, execute) {
  if (!idempotencyKey) throw Object.assign(new Error('idempotency key is required'), { code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400 });
  const client = await pool.connect(); const payloadHash = hashPayload(payload); let actionId;
  try {
    await client.query('BEGIN'); const actor = await resolveActor(client, actorEntityId);
    if (actor.world_id !== worldId) throw Object.assign(new Error('actor belongs to a different world'), { code: 'WORLD_MISMATCH', status: 403 });
    const inserted = await client.query(`INSERT INTO core.actions (world_id, actor_entity_id, action_type, idempotency_key, payload_hash, status) VALUES ($1,$2,$3,$4,$5,'PENDING') ON CONFLICT (world_id, actor_entity_id, idempotency_key) DO NOTHING RETURNING action_id`, [worldId, actorEntityId, actionType, idempotencyKey, payloadHash]);
    if (inserted.rowCount === 0) {
      const existing = await client.query(`SELECT action_id, action_type, payload_hash, status, result_json, error_code FROM core.actions WHERE world_id=$1 AND actor_entity_id=$2 AND idempotency_key=$3 FOR UPDATE`, [worldId, actorEntityId, idempotencyKey]);
      const row = existing.rows[0];
      if (row.action_type !== actionType || row.payload_hash !== payloadHash) throw Object.assign(new Error('same idempotency key used with different command'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      await client.query('COMMIT');
      if (row.status === 'SUCCEEDED') return { replayed: true, actionId: row.action_id, result: row.result_json };
      throw Object.assign(new Error(`previous command status is ${row.status}`), { code: row.error_code || 'COMMAND_NOT_REPLAYABLE', status: 409 });
    }
    actionId = inserted.rows[0].action_id; await client.query('SAVEPOINT domain_work');
    try {
      const result = await execute(client, { actionId, actor });
      await client.query(`UPDATE core.actions SET status='SUCCEEDED', result_json=$2::jsonb, completed_at=now() WHERE action_id=$1`, [actionId, JSON.stringify(result)]);
      await appendEvent(client, { worldId, aggregateType: 'ACTION', aggregateId: actionId, eventType: 'ACTION_SUCCEEDED', actorEntityId, actionId, payload: { actionType } });
      await client.query('RELEASE SAVEPOINT domain_work'); await client.query('COMMIT'); return { replayed: false, actionId, result };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT domain_work');
      await client.query(`UPDATE core.actions SET status='FAILED', error_code=$2, result_json=$3::jsonb, completed_at=now() WHERE action_id=$1`, [actionId, error.code || 'COMMAND_FAILED', JSON.stringify({ message: error.message })]);
      await appendEvent(client, { worldId, aggregateType: 'ACTION', aggregateId: actionId, eventType: 'ACTION_FAILED', actorEntityId, actionId, payload: { actionType, errorCode: error.code || 'COMMAND_FAILED' } });
      await client.query('COMMIT'); error.actionId = actionId; throw error;
    }
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}

export async function createEntity(client, { worldId, entityType, displayId, name, createdBy = null, origin = 'LOCAL' }, context = {}) {
  if (!ENTITY_TYPES.includes(entityType)) throw Object.assign(new Error('invalid entity type'), { code: 'INVALID_ENTITY_TYPE', status: 400 });
  const result = await client.query(`INSERT INTO core.entities (world_id, entity_type, display_id, name, created_by, origin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING entity_id, world_id, entity_type, display_id, name, identity_status, created_at`, [worldId, entityType, displayId, name, createdBy, origin]);
  const entity = result.rows[0];
  await client.query('INSERT INTO economy.wallets (world_id, entity_id) VALUES ($1,$2)', [worldId, entity.entity_id]);
  await client.query('INSERT INTO economy.activity_subjects (world_id, entity_id) VALUES ($1,$2)', [worldId, entity.entity_id]);
  await appendEvent(client, { worldId, aggregateType: 'ENTITY', aggregateId: entity.entity_id, eventType: 'ENTITY_CREATED', actorEntityId: context.actorEntityId || createdBy, actionId: context.actionId, payload: { entityType, displayId } });
  return entity;
}
