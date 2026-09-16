import { appendEvent, resolveActor } from './core.js';
import { resumeRuntime } from './runtime_policy.js';

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function nonEmpty(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw problem('INVALID_RUNTIME_INPUT', `${field} must be non-empty text up to ${max} characters`);
  }
  return value.trim();
}

function asInstant(value, field = 'now') {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw problem('INVALID_RUNTIME_INPUT', `${field} must be a valid timestamp`);
  return d.toISOString();
}

async function assertSystem(client, worldId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'scheduler execution requires SYSTEM actor', 403);
  return actor;
}

async function bumpState(client, worldId, subjectId) {
  const row = (await client.query(
    `UPDATE runtime.lifecycle_states SET state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2 RETURNING state_version`,
    [worldId, subjectId],
  )).rows[0];
  if (!row) throw problem('RUNTIME_STATE_NOT_FOUND', 'runtime lifecycle state not found', 404);
  return row.state_version;
}

const BLOCKABLE = new Set([
  'M03_CONTEXT_UNAVAILABLE',
  'RUNTIME_RESTRICTED',
  'MODEL_ROUTE_UNAVAILABLE',
  'DAILY_FEE_UNFUNDED',
  'FIRST_ACTIVATION_MINIMUM_UNFUNDED',
  'NO_AVAILABLE_ENERGY',
]);

export async function runDueWakeScheduledAction(client, {
  worldId,
  scheduledActionId,
  workerId,
  billingDate,
  actorEntityId,
  actionId,
  now = new Date().toISOString(),
}) {
  const actor = await assertSystem(client, worldId, actorEntityId);
  workerId = nonEmpty(workerId, 'workerId');
  const nowIso = asInstant(now);
  const row = (await client.query(
    `SELECT * FROM runtime.scheduled_actions WHERE world_id=$1 AND scheduled_action_id=$2 FOR UPDATE`,
    [worldId, scheduledActionId],
  )).rows[0];
  if (!row) throw problem('SCHEDULED_ACTION_NOT_FOUND', 'scheduled action not found', 404);
  if (row.action_kind !== 'WAKE') throw problem('WRONG_SCHEDULE_PATH', 'only WAKE schedules use the atomic wake scheduler path', 409);
  if (row.status !== 'SCHEDULED') throw problem('SCHEDULED_ACTION_NOT_RUNNABLE', `scheduled action is ${row.status}`, 409);
  if (new Date(row.due_at) > new Date(nowIso)) throw problem('SCHEDULED_ACTION_NOT_DUE', 'scheduled action is not due yet', 409);

  if (row.latest_run_at && new Date(nowIso) > new Date(row.latest_run_at) && row.missed_policy === 'SKIP') {
    const stateVersion = await bumpState(client, worldId, row.subject_id);
    const missed = (await client.query(
      `UPDATE runtime.scheduled_actions
          SET status='MISSED',claimed_by_worker=$3,claimed_at=now(),completed_at=now(),updated_at=now()
        WHERE world_id=$1 AND scheduled_action_id=$2 RETURNING *`,
      [worldId, scheduledActionId, workerId],
    )).rows[0];
    if (actionId) await appendEvent(client, {
      worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: row.subject_id,
      eventType: 'SCHEDULED_WAKE_MISSED', actorEntityId: actor.entity_id, actionId,
      payload: { scheduledActionId, workerId, stateVersion },
    });
    return { schedule: missed, lifecycle: null, state_version: stateVersion, result: 'MISSED' };
  }

  try {
    const activation = await resumeRuntime(client, {
      worldId,
      agentEntityId: row.subject_id,
      billingDate,
      reason: `scheduled wake ${scheduledActionId}`,
      actorEntityId: actor.entity_id,
      actionId,
    });
    const completed = (await client.query(
      `UPDATE runtime.scheduled_actions
          SET status='COMPLETED',claimed_by_worker=$3,claimed_at=now(),completed_at=now(),updated_at=now(),blocked_reason=NULL
        WHERE world_id=$1 AND scheduled_action_id=$2 RETURNING *`,
      [worldId, scheduledActionId, workerId],
    )).rows[0];
    if (actionId) await appendEvent(client, {
      worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: row.subject_id,
      eventType: 'SCHEDULED_WAKE_COMPLETED', actorEntityId: actor.entity_id, actionId,
      payload: { scheduledActionId, workerId, lifecycleStateVersion: activation.lifecycle.state_version },
    });
    return { schedule: completed, lifecycle: activation.lifecycle, economic: activation.economic, result: 'COMPLETED' };
  } catch (error) {
    if (!BLOCKABLE.has(error.code)) throw error;
    const stateVersion = await bumpState(client, worldId, row.subject_id);
    const blocked = (await client.query(
      `UPDATE runtime.scheduled_actions
          SET status='BLOCKED',claimed_by_worker=$3,claimed_at=now(),completed_at=now(),blocked_reason=$4,updated_at=now()
        WHERE world_id=$1 AND scheduled_action_id=$2 RETURNING *`,
      [worldId, scheduledActionId, workerId, error.code],
    )).rows[0];
    if (actionId) await appendEvent(client, {
      worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: row.subject_id,
      eventType: 'SCHEDULED_WAKE_BLOCKED', actorEntityId: actor.entity_id, actionId,
      payload: { scheduledActionId, workerId, reason: error.code, stateVersion },
    });
    return { schedule: blocked, lifecycle: null, state_version: stateVersion, result: 'BLOCKED', reason: error.code };
  }
}