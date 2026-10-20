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

async function assertSystem(client, worldId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'scheduler execution requires SYSTEM actor', 403);
  return actor;
}

async function databaseNowIso(client) {
  const row = (await client.query(`SELECT now() current_time`)).rows[0];
  return new Date(row.current_time).toISOString();
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

async function markWakeBlockedState(client, worldId, subjectId, code) {
  const flag = code === 'DAILY_FEE_UNFUNDED'
    ? 'DAILY_FEE_UNFUNDED'
    : (code === 'FIRST_ACTIVATION_MINIMUM_UNFUNDED' || code === 'NO_AVAILABLE_ENERGY')
      ? 'NO_ACTIVITY_ENERGY'
      : null;
  if (!flag) return bumpState(client, worldId, subjectId);
  const row = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET restriction_flags=CASE WHEN $3=ANY(restriction_flags) THEN restriction_flags ELSE array_append(restriction_flags,$3) END,
            state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING state_version`,
    [worldId, subjectId, flag],
  )).rows[0];
  if (!row) throw problem('RUNTIME_STATE_NOT_FOUND', 'runtime lifecycle state not found', 404);
  return row.state_version;
}

async function recordWakeEvidence(client, {
  worldId, scheduledActionId, subjectId, outcome, workerId, billingDate = null,
  lifecycleStateVersion = null, blockedReason = null, actionId = null, actorEntityId,
}) {
  return (await client.query(
    `INSERT INTO runtime.scheduled_wake_executions
      (world_id,scheduled_action_id,subject_id,outcome,worker_id,billing_date,lifecycle_state_version,blocked_reason,action_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING wake_execution_id,created_at`,
    [worldId, scheduledActionId, subjectId, outcome, workerId, billingDate, lifecycleStateVersion, blockedReason, actionId, actorEntityId],
  )).rows[0];
}

const BLOCKABLE = new Set([
  'M03_CONTEXT_UNAVAILABLE',
  'RUNTIME_RESTRICTED',
  'MODEL_ROUTE_UNAVAILABLE',
  'DAILY_FEE_UNFUNDED',
  'FIRST_ACTIVATION_MINIMUM_UNFUNDED',
  'NO_AVAILABLE_ENERGY',
  'IDENTITY_NOT_ACTIVE',
]);

export async function runDueWakeScheduledAction(client, {
  worldId,
  scheduledActionId,
  workerId,
  billingDate: _billingDate,
  actorEntityId,
  actionId,
  now: _now,
}) {
  const actor = await assertSystem(client, worldId, actorEntityId);
  workerId = nonEmpty(workerId, 'workerId');
  const authoritativeNow = await databaseNowIso(client);
  const billingDate = authoritativeNow.slice(0, 10);
  const row = (await client.query(
    `SELECT * FROM runtime.scheduled_actions WHERE world_id=$1 AND scheduled_action_id=$2 FOR UPDATE`,
    [worldId, scheduledActionId],
  )).rows[0];
  if (!row) throw problem('SCHEDULED_ACTION_NOT_FOUND', 'scheduled action not found', 404);
  if (row.action_kind !== 'WAKE') throw problem('WRONG_SCHEDULE_PATH', 'only WAKE schedules use the atomic wake scheduler path', 409);
  if (row.status !== 'SCHEDULED') throw problem('SCHEDULED_ACTION_NOT_RUNNABLE', `scheduled action is ${row.status}`, 409);
  if (new Date(row.due_at) > new Date(authoritativeNow)) throw problem('SCHEDULED_ACTION_NOT_DUE', 'scheduled action is not due yet', 409);

  if (row.latest_run_at && new Date(authoritativeNow) > new Date(row.latest_run_at) && row.missed_policy === 'SKIP') {
    const stateVersion = await bumpState(client, worldId, row.subject_id);
    await recordWakeEvidence(client, {
      worldId, scheduledActionId, subjectId: row.subject_id, outcome: 'MISSED', workerId,
      lifecycleStateVersion: stateVersion, actionId, actorEntityId: actor.entity_id,
    });
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
    await recordWakeEvidence(client, {
      worldId, scheduledActionId, subjectId: row.subject_id, outcome: 'COMPLETED', workerId,
      billingDate, lifecycleStateVersion: activation.lifecycle.state_version, actionId, actorEntityId: actor.entity_id,
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
      payload: { scheduledActionId, workerId, billingDate, lifecycleStateVersion: activation.lifecycle.state_version },
    });
    return { schedule: completed, lifecycle: activation.lifecycle, economic: activation.economic, result: 'COMPLETED' };
  } catch (error) {
    if (!BLOCKABLE.has(error.code)) throw error;
    const stateVersion = await markWakeBlockedState(client, worldId, row.subject_id, error.code);
    await recordWakeEvidence(client, {
      worldId, scheduledActionId, subjectId: row.subject_id, outcome: 'BLOCKED', workerId,
      lifecycleStateVersion: stateVersion, blockedReason: error.code, actionId, actorEntityId: actor.entity_id,
    });
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
