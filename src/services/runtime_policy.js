import { appendEvent, resolveActor } from './core.js';
import { activateRuntime, claimScheduledAction, getExecutionEligibility } from './runtime_control.js';

const POLICY_BLOCKING_FLAGS = new Set(['OWNER_PAUSE','NO_BUDGET','QUARANTINE','WORLD_SUSPENSION']);

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

async function systemActor(client, worldId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'runtime policy mutation requires SYSTEM actor', 403);
  return actor;
}

async function subjectOrSystem(client, worldId, subjectId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM' && actor.entity_id !== subjectId) throw problem('FORBIDDEN', 'actor cannot control another runtime subject', 403);
  return actor;
}

async function lockedState(client, worldId, subjectId) {
  const row = (await client.query(
    `SELECT life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at
       FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, subjectId],
  )).rows[0];
  if (!row) throw problem('RUNTIME_STATE_NOT_FOUND', 'runtime lifecycle state not found', 404);
  return row;
}

async function assertQuiescent(client, worldId, subjectId, state) {
  if (state.execution_status === 'RUNNING') throw problem('RUNTIME_NOT_QUIESCENT', 'runtime is RUNNING', 409);
  const activeLease = (await client.query(
    `SELECT 1 FROM runtime.runtime_leases
      WHERE world_id=$1 AND activity_subject_id=$2 AND released_at IS NULL AND expires_at > now()`,
    [worldId, subjectId],
  )).rowCount === 1;
  if (activeLease) throw problem('RUNTIME_NOT_QUIESCENT', 'runtime has an active worker lease', 409);
}

export async function getRuntimeEligibility(client, input) {
  const base = await getExecutionEligibility(client, input);
  const policyFlags = base.restriction_flags.filter((flag) => POLICY_BLOCKING_FLAGS.has(flag));
  if (!policyFlags.length) return base;
  return {
    ...base,
    can_respond_inbound: false,
    can_seek_tasks: false,
    can_autonomous_turn: false,
    reasons: [...new Set([...base.reasons, ...policyFlags])],
  };
}

export async function resumeRuntime(client, input) {
  await subjectOrSystem(client, input.worldId, input.agentEntityId, input.actorEntityId);
  const state = await lockedState(client, input.worldId, input.agentEntityId);
  const blocking = state.restriction_flags.filter((flag) => POLICY_BLOCKING_FLAGS.has(flag));
  if (blocking.length) {
    throw problem('RUNTIME_RESTRICTED', `runtime restrictions must be explicitly cleared before resume: ${blocking.join(',')}`, 409);
  }
  return activateRuntime(client, input);
}

export async function setRuntimeRestriction(client, {
  worldId, agentEntityId, restriction, enabled, reason, actorEntityId, actionId,
}) {
  const actor = await systemActor(client, worldId, actorEntityId);
  if (!POLICY_BLOCKING_FLAGS.has(restriction)) throw problem('INVALID_RUNTIME_INPUT', 'restriction is not policy-mutable in P3-B');
  if (typeof enabled !== 'boolean') throw problem('INVALID_RUNTIME_INPUT', 'enabled must be boolean');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw problem('INVALID_RUNTIME_INPUT', 'reason must be non-empty text up to 2000 characters');
  const state = await lockedState(client, worldId, agentEntityId);
  const flags = new Set(state.restriction_flags ?? []);
  if (flags.has(restriction) === enabled) return { lifecycle: state, replayed: true };

  let nextLife = state.life_status;
  let nextExecution = state.execution_status;
  let dormantReason = state.dormant_reason;
  if (enabled && state.life_status === 'ACTIVE') {
    await assertQuiescent(client, worldId, agentEntityId, state);
    nextLife = 'DORMANT';
    nextExecution = 'BLOCKED';
    dormantReason = restriction;
  }
  if (enabled) flags.add(restriction); else flags.delete(restriction);

  const updated = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET life_status=$3,execution_status=$4,restriction_flags=$5::text[],dormant_reason=$6,
            state_version=state_version+1,
            last_transition_at=CASE WHEN life_status IS DISTINCT FROM $3 THEN now() ELSE last_transition_at END,
            updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at`,
    [worldId, agentEntityId, nextLife, nextExecution, [...flags], dormantReason],
  )).rows[0];

  if (state.life_status !== nextLife) {
    await client.query(
      `INSERT INTO runtime.lifecycle_transition_events
        (world_id,activity_subject_id,from_life_status,to_life_status,reason,state_version,action_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [worldId, agentEntityId, state.life_status, nextLife, reason.trim(), updated.state_version, actionId ?? null, actor.entity_id],
    );
  }
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: agentEntityId,
    eventType: enabled ? 'RUNTIME_RESTRICTION_ENABLED' : 'RUNTIME_RESTRICTION_DISABLED',
    actorEntityId: actor.entity_id, actionId,
    payload: { restriction, enabled, reason: reason.trim(), stateVersion: updated.state_version },
  });
  return { lifecycle: updated, replayed: false };
}

export async function claimAutonomousScheduledAction(client, input) {
  await systemActor(client, input.worldId, input.actorEntityId);
  const row = (await client.query(
    `SELECT action_kind FROM runtime.scheduled_actions WHERE world_id=$1 AND scheduled_action_id=$2`,
    [input.worldId, input.scheduledActionId],
  )).rows[0];
  if (!row) throw problem('SCHEDULED_ACTION_NOT_FOUND', 'scheduled action not found', 404);
  if (row.action_kind !== 'AUTONOMOUS_TURN') throw problem('WRONG_SCHEDULE_PATH', 'WAKE schedules must use the atomic wake scheduler path', 409);
  return claimScheduledAction(client, input);
}
