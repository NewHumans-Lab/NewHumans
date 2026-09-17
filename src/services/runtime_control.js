import { appendEvent, resolveActor } from './core.js';
import { chargeDailyActivityFee, firstActivation, getWallet } from './economy.js';

const HARD_RUNTIME_FLAGS = new Set(['OWNER_PAUSE', 'QUARANTINE', 'WORLD_SUSPENSION']);
const GOAL_TERMINAL = new Set(['COMPLETED', 'ABANDONED', 'FAILED']);
const GOAL_TRANSITIONS = new Map([
  ['PROPOSED', new Set(['ACTIVE', 'PAUSED', 'BLOCKED', 'ABANDONED'])],
  ['ACTIVE', new Set(['PAUSED', 'BLOCKED', 'COMPLETED', 'ABANDONED', 'FAILED'])],
  ['PAUSED', new Set(['ACTIVE', 'BLOCKED', 'ABANDONED'])],
  ['BLOCKED', new Set(['ACTIVE', 'PAUSED', 'ABANDONED', 'FAILED'])],
]);

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function text(value, field, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw problem('INVALID_RUNTIME_INPUT', `${field} must be non-empty text up to ${max} characters`);
  }
  return value.trim();
}

function object(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw problem('INVALID_RUNTIME_INPUT', `${field} must be an object`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function microE(value, field, { nullable = true } = {}) {
  if ((value === undefined || value === null) && nullable) return null;
  const s = String(value);
  if (!/^\d+$/.test(s)) throw problem('INVALID_AMOUNT', `${field} must be a non-negative decimal integer string`);
  return s;
}

function positiveVersion(value, field = 'expectedVersion') {
  const s = String(value);
  if (!/^[1-9]\d*$/.test(s)) throw problem('INVALID_RUNTIME_INPUT', `${field} must be a positive integer`);
  return s;
}

function billingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw problem('INVALID_RUNTIME_INPUT', 'billingDate must be YYYY-MM-DD');
  return value;
}

function instant(value, field, { nullable = false } = {}) {
  if ((value === undefined || value === null) && nullable) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw problem('INVALID_RUNTIME_INPUT', `${field} must be a valid timestamp`);
  return d.toISOString();
}

async function actorForSubject(client, worldId, subjectId, actorEntityId, { systemOnly = false } = {}) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (systemOnly) {
    if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'operation requires SYSTEM actor', 403);
  } else if (actor.entity_type !== 'SYSTEM' && actor.entity_id !== subjectId) {
    throw problem('FORBIDDEN', 'actor cannot control another runtime subject', 403);
  }
  return actor;
}

async function profile(client, worldId, subjectId, lock = false) {
  const row = (await client.query(
    `SELECT world_id,agent_entity_id,current_route_id,profile_version
       FROM runtime.agent_profiles WHERE world_id=$1 AND agent_entity_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [worldId, subjectId],
  )).rows[0];
  if (!row) throw problem('RUNTIME_PROFILE_NOT_FOUND', 'runtime profile not found', 404);
  return row;
}

async function lifecycle(client, worldId, subjectId, lock = false) {
  const row = (await client.query(
    `SELECT life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at
       FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [worldId, subjectId],
  )).rows[0];
  if (!row) throw problem('RUNTIME_STATE_NOT_FOUND', 'runtime lifecycle state not found', 404);
  return row;
}

async function assertQuiescent(client, worldId, subjectId, state) {
  if (state.execution_status === 'RUNNING') throw problem('RUNTIME_NOT_QUIESCENT', 'runtime is RUNNING', 409);
  const lease = (await client.query(
    `SELECT worker_id,lease_epoch FROM runtime.runtime_leases
      WHERE world_id=$1 AND activity_subject_id=$2 AND released_at IS NULL AND expires_at > now()`,
    [worldId, subjectId],
  )).rows[0];
  if (lease) throw problem('RUNTIME_NOT_QUIESCENT', `active runtime lease is held by ${lease.worker_id}`, 409);
}

async function routeAvailable(client, worldId, subjectId, currentRouteId) {
  if (!currentRouteId) return false;
  const row = (await client.query(
    `SELECT d.status descriptor_status,c.enabled connector_enabled
       FROM runtime.model_routes r
       JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
       JOIN gateway.capability_descriptors d ON d.world_id=m.world_id AND d.descriptor_id=m.gateway_descriptor_id
       JOIN gateway.connector_configs c ON c.world_id=m.world_id AND c.connector_id=m.gateway_connector_id AND c.descriptor_id=m.gateway_descriptor_id
      WHERE r.world_id=$1 AND r.agent_entity_id=$2 AND r.route_id=$3`,
    [worldId, subjectId, currentRouteId],
  )).rows[0];
  return row?.descriptor_status === 'ACTIVE' && row?.connector_enabled === true;
}

function flagSet(row) {
  return new Set(row.restriction_flags ?? []);
}

function hasHardRestriction(flags) {
  return [...flags].some((flag) => HARD_RUNTIME_FLAGS.has(flag));
}

async function bumpState(client, worldId, subjectId) {
  const result = await client.query(
    `UPDATE runtime.lifecycle_states SET state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2 RETURNING state_version`,
    [worldId, subjectId],
  );
  return result.rows[0].state_version;
}

async function recordTransition(client, {
  worldId, subjectId, fromStatus, toStatus, reason, billingDateValue = null, stateVersion, actorEntityId, actionId,
}) {
  await client.query(
    `INSERT INTO runtime.lifecycle_transition_events
      (world_id,activity_subject_id,from_life_status,to_life_status,reason,billing_date,state_version,action_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [worldId, subjectId, fromStatus, toStatus, reason, billingDateValue, stateVersion, actionId ?? null, actorEntityId],
  );
  if (actionId) await appendEvent(client, {
    worldId,
    aggregateType: 'RUNTIME_AGENT',
    aggregateId: subjectId,
    eventType: 'RUNTIME_LIFECYCLE_CHANGED',
    actorEntityId,
    actionId,
    payload: { from: fromStatus, to: toStatus, reason, billingDate: billingDateValue, stateVersion },
  });
}

export async function getExecutionEligibility(client, { worldId, agentEntityId, billingDate: date, actorEntityId }) {
  await actorForSubject(client, worldId, agentEntityId, actorEntityId);
  date = billingDate(date);
  const p = await profile(client, worldId, agentEntityId);
  const state = await lifecycle(client, worldId, agentEntityId);
  const entity = (await client.query(
    `SELECT identity_status FROM core.entities WHERE world_id=$1 AND entity_id=$2`,
    [worldId, agentEntityId],
  )).rows[0];
  const wallet = await getWallet(client, worldId, agentEntityId);
  const activity = (await client.query(
    `SELECT first_activated_at FROM economy.activity_subjects WHERE world_id=$1 AND entity_id=$2`,
    [worldId, agentEntityId],
  )).rows[0] ?? null;
  const feePaid = (await client.query(
    `SELECT 1 FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3 AND status='CHARGED'`,
    [worldId, agentEntityId, date],
  )).rowCount === 1;
  const routeIsAvailable = await routeAvailable(client, worldId, agentEntityId, p.current_route_id);
  const available = BigInt(wallet.available_micro_e);
  const flags = flagSet(state);
  const executionReady = ['IDLE','RUNNABLE'].includes(state.execution_status);
  const reasons = [];
  if (entity?.identity_status !== 'ACTIVE') reasons.push('IDENTITY_NOT_ACTIVE');
  if (state.life_status !== 'ACTIVE') reasons.push(`LIFE_${state.life_status}`);
  if (!executionReady) reasons.push(`EXECUTION_${state.execution_status}`);
  if (!feePaid) reasons.push('DAILY_FEE_REQUIRED');
  if (available <= 0n) reasons.push('NO_AVAILABLE_ENERGY');
  if (state.model_status !== 'AVAILABLE' || !routeIsAvailable || flags.has('NO_MODEL_ROUTE')) reasons.push('MODEL_ROUTE_UNAVAILABLE');
  for (const flag of flags) if (HARD_RUNTIME_FLAGS.has(flag)) reasons.push(flag);
  if (flags.has('M03_CONTEXT_UNAVAILABLE')) reasons.push('M03_CONTEXT_UNAVAILABLE');

  const baseRuntimeReady = entity?.identity_status === 'ACTIVE'
    && state.life_status === 'ACTIVE'
    && executionReady
    && feePaid
    && available > 0n
    && state.model_status === 'AVAILABLE'
    && routeIsAvailable
    && !flags.has('NO_MODEL_ROUTE')
    && !hasHardRestriction(flags);
  const cognitionReady = baseRuntimeReady && !flags.has('M03_CONTEXT_UNAVAILABLE');

  return {
    world_id: worldId,
    activity_subject_id: agentEntityId,
    life_status: state.life_status,
    execution_status: state.execution_status,
    model_status: state.model_status,
    state_version: state.state_version,
    first_activated_at: activity?.first_activated_at ?? null,
    billing_date: date,
    daily_fee_paid: feePaid,
    available_micro_e: available.toString(),
    restriction_flags: state.restriction_flags,
    route_available: routeIsAvailable,
    can_receive_inbound: entity?.identity_status === 'ACTIVE' && state.life_status !== 'TERMINATED',
    can_respond_inbound: cognitionReady,
    can_seek_tasks: cognitionReady && available >= 100000000n,
    can_autonomous_turn: cognitionReady,
    reasons: [...new Set(reasons)],
  };
}

export async function activateRuntime(client, {
  worldId, agentEntityId, billingDate: date, reason = 'runtime activation', actorEntityId, actionId,
}) {
  const actor = await actorForSubject(client, worldId, agentEntityId, actorEntityId);
  date = billingDate(date);
  reason = text(reason, 'reason');
  const p = await profile(client, worldId, agentEntityId, true);
  const subject = (await client.query(
    `SELECT identity_status FROM core.entities WHERE world_id=$1 AND entity_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (subject?.identity_status !== 'ACTIVE') {
    throw problem('IDENTITY_NOT_ACTIVE', 'runtime activation requires an ACTIVE M01 Agent identity', 409);
  }
  const state = await lifecycle(client, worldId, agentEntityId, true);
  if (state.life_status === 'ACTIVE') return { lifecycle: state, replayed: true };
  if (!['REGISTERED', 'DORMANT'].includes(state.life_status)) throw problem('INVALID_LIFECYCLE_TRANSITION', `${state.life_status} cannot activate`, 409);
  const flags = flagSet(state);
  if (flags.has('M03_CONTEXT_UNAVAILABLE')) throw problem('M03_CONTEXT_UNAVAILABLE', 'runtime activation is blocked until the authoritative M03 context provider is adopted', 409);
  if (hasHardRestriction(flags)) throw problem('RUNTIME_RESTRICTED', 'runtime has a hard restriction that activation cannot clear', 409);
  if (state.model_status !== 'AVAILABLE' || flags.has('NO_MODEL_ROUTE') || !(await routeAvailable(client, worldId, agentEntityId, p.current_route_id))) {
    throw problem('MODEL_ROUTE_UNAVAILABLE', 'runtime has no available authorized model route', 409);
  }
  await assertQuiescent(client, worldId, agentEntityId, state);

  const activity = (await client.query(
    `SELECT first_activated_at FROM economy.activity_subjects WHERE world_id=$1 AND entity_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  const economic = activity?.first_activated_at
    ? await chargeDailyActivityFee(client, { worldId, entityId: agentEntityId, billingDate: date, actorEntityId, actionId })
    : await firstActivation(client, { worldId, entityId: agentEntityId, billingDate: date, actorEntityId, actionId });

  const nextFlags = [...flags].filter((flag) => !['NO_ACTIVITY_ENERGY', 'DAILY_FEE_UNFUNDED'].includes(flag));
  const updated = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET life_status='ACTIVE',execution_status='IDLE',restriction_flags=$3::text[],dormant_reason=NULL,
            state_version=state_version+1,last_transition_at=now(),updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at`,
    [worldId, agentEntityId, nextFlags],
  )).rows[0];
  await recordTransition(client, {
    worldId, subjectId: agentEntityId, fromStatus: state.life_status, toStatus: 'ACTIVE', reason,
    billingDateValue: date, stateVersion: updated.state_version, actorEntityId: actor.entity_id, actionId,
  });
  return { lifecycle: updated, economic, replayed: false };
}

export async function pauseRuntime(client, {
  worldId, agentEntityId, reason = 'self requested dormancy', reasonCode = 'USER_REQUEST', actorEntityId, actionId,
}) {
  const actor = await actorForSubject(client, worldId, agentEntityId, actorEntityId);
  reason = text(reason, 'reason');
  const state = await lifecycle(client, worldId, agentEntityId, true);
  if (state.life_status === 'DORMANT') return { lifecycle: state, replayed: true };
  if (state.life_status !== 'ACTIVE') throw problem('INVALID_LIFECYCLE_TRANSITION', `${state.life_status} cannot enter dormancy`, 409);
  await assertQuiescent(client, worldId, agentEntityId, state);
  const flags = flagSet(state);
  if (reasonCode === 'OWNER_PAUSE') {
    if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'OWNER_PAUSE may only be recorded by trusted system authorization', 403);
    flags.add('OWNER_PAUSE');
  } else if (['NO_BUDGET', 'NO_ACTIVITY_ENERGY', 'DAILY_FEE_UNFUNDED'].includes(reasonCode)) {
    flags.add(reasonCode);
  } else if (reasonCode !== 'USER_REQUEST') {
    throw problem('INVALID_RUNTIME_INPUT', 'unsupported dormancy reasonCode');
  }
  const updated = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET life_status='DORMANT',execution_status='BLOCKED',restriction_flags=$3::text[],dormant_reason=$4,
            state_version=state_version+1,last_transition_at=now(),updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at`,
    [worldId, agentEntityId, [...flags], reasonCode],
  )).rows[0];
  await recordTransition(client, {
    worldId, subjectId: agentEntityId, fromStatus: 'ACTIVE', toStatus: 'DORMANT', reason,
    stateVersion: updated.state_version, actorEntityId: actor.entity_id, actionId,
  });
  return { lifecycle: updated, replayed: false };
}

export async function reconcileActiveRuntime(client, { worldId, agentEntityId, billingDate: date, actorEntityId, actionId }) {
  const actor = await actorForSubject(client, worldId, agentEntityId, actorEntityId, { systemOnly: true });
  date = billingDate(date);
  const state = await lifecycle(client, worldId, agentEntityId, true);
  if (state.life_status !== 'ACTIVE') return { lifecycle: state, changed: false };
  const wallet = await getWallet(client, worldId, agentEntityId);
  let reasonCode = null;
  let fee = null;
  if (BigInt(wallet.available_micro_e) <= 0n) {
    reasonCode = 'NO_ACTIVITY_ENERGY';
  } else {
    const paid = (await client.query(
      `SELECT 1 FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3 AND status='CHARGED'`,
      [worldId, agentEntityId, date],
    )).rowCount === 1;
    if (!paid) {
      try {
        fee = await chargeDailyActivityFee(client, { worldId, entityId: agentEntityId, billingDate: date, actorEntityId, actionId });
      } catch (error) {
        if (error.code !== 'DAILY_FEE_UNFUNDED') throw error;
        reasonCode = 'DAILY_FEE_UNFUNDED';
      }
    }
  }
  if (!reasonCode) return { lifecycle: await lifecycle(client, worldId, agentEntityId), fee, changed: false };
  await assertQuiescent(client, worldId, agentEntityId, state);
  const flags = flagSet(state); flags.add(reasonCode);
  const updated = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET life_status='DORMANT',execution_status='BLOCKED',restriction_flags=$3::text[],dormant_reason=$4,
            state_version=state_version+1,last_transition_at=now(),updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at`,
    [worldId, agentEntityId, [...flags], reasonCode],
  )).rows[0];
  await recordTransition(client, {
    worldId, subjectId: agentEntityId, fromStatus: 'ACTIVE', toStatus: 'DORMANT',
    reason: `runtime reconciled to dormancy: ${reasonCode}`, billingDateValue: date,
    stateVersion: updated.state_version, actorEntityId: actor.entity_id, actionId,
  });
  return { lifecycle: updated, fee, changed: true };
}

export async function setModelStatus(client, { worldId, agentEntityId, modelStatus, reason, actorEntityId, actionId }) {
  const actor = await actorForSubject(client, worldId, agentEntityId, actorEntityId, { systemOnly: true });
  if (!['AVAILABLE','TEMPORARILY_UNAVAILABLE','RETIRED','CONTINUITY_UNCERTAIN'].includes(modelStatus)) {
    throw problem('INVALID_RUNTIME_INPUT', 'invalid modelStatus');
  }
  reason = text(reason, 'reason');
  const state = await lifecycle(client, worldId, agentEntityId, true);
  if (state.model_status === modelStatus) return { lifecycle: state, replayed: true };
  if (modelStatus !== 'AVAILABLE' && state.life_status === 'ACTIVE') await assertQuiescent(client, worldId, agentEntityId, state);
  const modelCausesDormancy = modelStatus !== 'AVAILABLE' && state.life_status === 'ACTIVE';
  const nextLife = modelCausesDormancy ? 'DORMANT' : state.life_status;
  const nextExecution = modelStatus !== 'AVAILABLE' ? 'BLOCKED' : state.execution_status;
  const nextDormantReason = modelCausesDormancy ? 'MODEL_UNAVAILABLE' : state.dormant_reason;
  const updated = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET model_status=$3,life_status=$4,execution_status=$5,dormant_reason=$6,
            state_version=state_version+1,
            last_transition_at=CASE WHEN life_status IS DISTINCT FROM $4 THEN now() ELSE last_transition_at END,
            updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version,dormant_reason,last_transition_at,updated_at`,
    [worldId, agentEntityId, modelStatus, nextLife, nextExecution, nextDormantReason],
  )).rows[0];
  if (state.life_status !== nextLife) await recordTransition(client, {
    worldId, subjectId: agentEntityId, fromStatus: state.life_status, toStatus: nextLife, reason,
    stateVersion: updated.state_version, actorEntityId: actor.entity_id, actionId,
  });
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: agentEntityId,
    eventType: 'MODEL_STATUS_CHANGED', actorEntityId: actor.entity_id, actionId,
    payload: { from: state.model_status, to: modelStatus, reason, stateVersion: updated.state_version },
  });
  return { lifecycle: updated, replayed: false };
}

export async function updateGoal(client, {
  worldId, subjectId, goalId, expectedVersion, status, goalText, priority, rationale,
  budgetMicroE, deadline, successEvidence, changeReason, actorEntityId, actionId,
}) {
  const actor = await actorForSubject(client, worldId, subjectId, actorEntityId);
  expectedVersion = positiveVersion(expectedVersion);
  changeReason = text(changeReason, 'changeReason');
  await profile(client, worldId, subjectId, true);
  const goal = (await client.query(
    `SELECT * FROM runtime.goals WHERE world_id=$1 AND subject_id=$2 AND goal_id=$3 FOR UPDATE`,
    [worldId, subjectId, goalId],
  )).rows[0];
  if (!goal) throw problem('GOAL_NOT_FOUND', 'goal not found', 404);
  if (String(goal.version) !== expectedVersion) throw problem('GOAL_VERSION_CONFLICT', `expected goal version ${expectedVersion} but current is ${goal.version}`, 409);
  if (goal.source === 'SELF' && actor.entity_id !== subjectId) throw problem('FORBIDDEN', 'SELF goal may only be changed by the subject', 403);
  if (goal.source === 'SYSTEM_OBLIGATION' && actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'SYSTEM_OBLIGATION requires SYSTEM actor', 403);
  if (['OWNER_DIRECTIVE','CONTRACT_OBLIGATION'].includes(goal.source)) throw problem('GOAL_SOURCE_DEFERRED', `${goal.source} authorization remains deferred`, 409);
  if (GOAL_TERMINAL.has(goal.status)) throw problem('GOAL_TERMINAL', 'terminal goal cannot be mutated; create a new goal instead', 409);
  const nextStatus = status ?? goal.status;
  if (nextStatus !== goal.status && !GOAL_TRANSITIONS.get(goal.status)?.has(nextStatus)) {
    throw problem('INVALID_GOAL_TRANSITION', `${goal.status} -> ${nextStatus} is not allowed`, 409);
  }
  const nextText = goalText === undefined ? goal.goal_text : text(goalText, 'goalText', 10000);
  const nextPriority = priority === undefined ? goal.priority : priority;
  if (!Number.isSafeInteger(nextPriority)) throw problem('INVALID_RUNTIME_INPUT', 'priority must be an integer');
  const nextBudget = budgetMicroE === undefined ? goal.budget_micro_e : microE(budgetMicroE, 'budgetMicroE');
  const nextDeadline = deadline === undefined ? goal.deadline : instant(deadline, 'deadline', { nullable: true });
  const nextEvidence = successEvidence === undefined ? goal.success_evidence : object(successEvidence, 'successEvidence');
  const nextRationale = rationale === undefined ? goal.rationale : (rationale === null ? null : text(rationale, 'rationale', 4000));

  await client.query(`SELECT set_config('newhumans.goal_change_reason',$1,true)`, [changeReason]);
  await client.query(`SELECT set_config('newhumans.goal_changed_by',$1,true)`, [actor.entity_id]);
  const updated = (await client.query(
    `UPDATE runtime.goals
        SET goal_text=$4,priority=$5,rationale=$6,budget_micro_e=$7,deadline=$8,success_evidence=$9::jsonb,status=$10,
            version=version+1,updated_at=now()
      WHERE world_id=$1 AND subject_id=$2 AND goal_id=$3
      RETURNING goal_id,world_id,subject_id,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,version,created_at,updated_at`,
    [worldId, subjectId, goalId, nextText, nextPriority, nextRationale, nextBudget, nextDeadline, JSON.stringify(nextEvidence), nextStatus],
  )).rows[0];
  const stateVersion = await bumpState(client, worldId, subjectId);
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: subjectId,
    eventType: 'GOAL_UPDATED', actorEntityId: actor.entity_id, actionId,
    payload: { goalId, goalVersion: updated.version, fromStatus: goal.status, toStatus: updated.status, stateVersion, changeReason },
  });
  return { ...updated, state_version: stateVersion };
}

export async function setTrait(client, {
  worldId, subjectId, traitKey, traitClass, valuePpm, expectedVersion = null,
  source, rationale, actorEntityId, actionId,
}) {
  const actor = await actorForSubject(client, worldId, subjectId, actorEntityId);
  traitKey = text(traitKey, 'traitKey', 100);
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(traitKey)) throw problem('INVALID_RUNTIME_INPUT', 'traitKey format is invalid');
  if (!['BIRTH','LEARNED','SHORT_TERM'].includes(traitClass)) throw problem('INVALID_RUNTIME_INPUT', 'invalid traitClass');
  if (!Number.isSafeInteger(valuePpm) || valuePpm < 0 || valuePpm > 1000000) throw problem('INVALID_RUNTIME_INPUT', 'valuePpm must be an integer from 0 to 1000000');
  if (!['BIRTH_CONFIGURATION','SELF_REFLECTION','OBSERVED_OUTCOME','SYSTEM_POLICY'].includes(source)) throw problem('INVALID_RUNTIME_INPUT', 'invalid trait update source');
  rationale = text(rationale, 'rationale', 4000);
  if (['BIRTH_CONFIGURATION','SYSTEM_POLICY'].includes(source) && actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', `${source} requires SYSTEM actor`, 403);
  if (source === 'SELF_REFLECTION' && actor.entity_id !== subjectId) throw problem('FORBIDDEN', 'SELF_REFLECTION requires the subject actor', 403);
  await profile(client, worldId, subjectId, true);
  const current = (await client.query(
    `SELECT * FROM runtime.trait_states WHERE world_id=$1 AND subject_id=$2 AND trait_key=$3 FOR UPDATE`,
    [worldId, subjectId, traitKey],
  )).rows[0];
  if (!current) {
    if (expectedVersion !== null && expectedVersion !== undefined) throw problem('TRAIT_VERSION_CONFLICT', 'trait does not exist yet', 409);
    await client.query(
      `INSERT INTO runtime.trait_states (world_id,subject_id,trait_key,trait_class,value_ppm,version,updated_by)
       VALUES ($1,$2,$3,$4,$5,1,$6)`,
      [worldId, subjectId, traitKey, traitClass, valuePpm, actor.entity_id],
    );
    await client.query(
      `INSERT INTO runtime.trait_updates
        (world_id,subject_id,trait_key,trait_class,from_value_ppm,to_value_ppm,version,source,rationale,action_id,created_by)
       VALUES ($1,$2,$3,$4,NULL,$5,1,$6,$7,$8,$9)`,
      [worldId, subjectId, traitKey, traitClass, valuePpm, source, rationale, actionId ?? null, actor.entity_id],
    );
    const stateVersion = await bumpState(client, worldId, subjectId);
    return { trait_key: traitKey, trait_class: traitClass, value_ppm: valuePpm, version: '1', state_version: stateVersion };
  }
  const expected = positiveVersion(expectedVersion);
  if (String(current.version) !== expected) throw problem('TRAIT_VERSION_CONFLICT', `expected trait version ${expected} but current is ${current.version}`, 409);
  if (current.trait_class !== traitClass) throw problem('TRAIT_CLASS_IMMUTABLE', 'traitClass cannot change in place', 409);
  if (traitClass === 'BIRTH') throw problem('BIRTH_TRAIT_IMMUTABLE', 'birth traits are immutable after creation', 409);
  const nextVersion = (BigInt(current.version) + 1n).toString();
  await client.query(
    `UPDATE runtime.trait_states SET value_ppm=$4,version=$5,updated_by=$6,updated_at=now()
      WHERE world_id=$1 AND subject_id=$2 AND trait_key=$3`,
    [worldId, subjectId, traitKey, valuePpm, nextVersion, actor.entity_id],
  );
  await client.query(
    `INSERT INTO runtime.trait_updates
      (world_id,subject_id,trait_key,trait_class,from_value_ppm,to_value_ppm,version,source,rationale,action_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [worldId, subjectId, traitKey, traitClass, current.value_ppm, valuePpm, nextVersion, source, rationale, actionId ?? null, actor.entity_id],
  );
  const stateVersion = await bumpState(client, worldId, subjectId);
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: subjectId,
    eventType: 'TRAIT_UPDATED', actorEntityId: actor.entity_id, actionId,
    payload: { traitKey, traitClass, fromValuePpm: current.value_ppm, toValuePpm: valuePpm, traitVersion: nextVersion, source, stateVersion },
  });
  return { trait_key: traitKey, trait_class: traitClass, value_ppm: valuePpm, version: nextVersion, state_version: stateVersion };
}

export async function scheduleAction(client, {
  worldId, subjectId, actionKind, dueAt, timezone = 'UTC', filter = {}, missedPolicy = 'RUN_ONCE',
  latestRunAt = null, budgetMicroE = null, priority = 0, dedupeKey, actorEntityId, actionId,
}) {
  const actor = await actorForSubject(client, worldId, subjectId, actorEntityId);
  if (!['WAKE','AUTONOMOUS_TURN'].includes(actionKind)) throw problem('INVALID_RUNTIME_INPUT', 'invalid actionKind');
  const due = instant(dueAt, 'dueAt');
  const latest = instant(latestRunAt, 'latestRunAt', { nullable: true });
  if (latest && new Date(latest) < new Date(due)) throw problem('INVALID_RUNTIME_INPUT', 'latestRunAt cannot precede dueAt');
  timezone = text(timezone, 'timezone', 100);
  filter = object(filter, 'filter');
  if (!['RUN_ONCE','SKIP'].includes(missedPolicy)) throw problem('INVALID_RUNTIME_INPUT', 'invalid missedPolicy');
  const budget = microE(budgetMicroE, 'budgetMicroE');
  if (!Number.isSafeInteger(priority)) throw problem('INVALID_RUNTIME_INPUT', 'priority must be an integer');
  dedupeKey = text(dedupeKey, 'dedupeKey', 200);
  await profile(client, worldId, subjectId, true);
  const existing = (await client.query(
    `SELECT * FROM runtime.scheduled_actions WHERE world_id=$1 AND subject_id=$2 AND dedupe_key=$3`,
    [worldId, subjectId, dedupeKey],
  )).rows[0];
  if (existing) {
    const same = existing.action_kind === actionKind
      && new Date(existing.due_at).toISOString() === due
      && existing.timezone === timezone
      && canonicalJson(existing.filter_json) === canonicalJson(filter)
      && existing.missed_policy === missedPolicy
      && (existing.latest_run_at === null ? null : new Date(existing.latest_run_at).toISOString()) === latest
      && String(existing.budget_micro_e ?? '') === String(budget ?? '')
      && existing.priority === priority;
    if (!same) throw problem('IDEMPOTENCY_CONFLICT', 'scheduled action dedupe key reused with different terms', 409);
    return { ...existing, replayed: true };
  }
  const row = (await client.query(
    `INSERT INTO runtime.scheduled_actions
      (world_id,subject_id,action_kind,due_at,timezone,filter_json,missed_policy,latest_run_at,budget_micro_e,priority,dedupe_key,created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [worldId, subjectId, actionKind, due, timezone, JSON.stringify(filter), missedPolicy, latest, budget, priority, dedupeKey, actor.entity_id],
  )).rows[0];
  const stateVersion = await bumpState(client, worldId, subjectId);
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: subjectId,
    eventType: 'SCHEDULED_ACTION_CREATED', actorEntityId: actor.entity_id, actionId,
    payload: { scheduledActionId: row.scheduled_action_id, actionKind, dueAt: due, dedupeKey, stateVersion },
  });
  return { ...row, state_version: stateVersion, replayed: false };
}

async function assertLease(client, worldId, subjectId, workerId, leaseEpoch) {
  workerId = text(workerId, 'workerId', 200);
  const epoch = positiveVersion(leaseEpoch, 'leaseEpoch');
  const lease = (await client.query(
    `SELECT worker_id,lease_epoch,(released_at IS NULL AND expires_at > now()) active
       FROM runtime.runtime_leases
      WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, subjectId],
  )).rows[0];
  if (!lease || lease.worker_id !== workerId || String(lease.lease_epoch) !== epoch || !lease.active) {
    throw problem('STALE_RUNTIME_LEASE', 'worker does not hold the current active runtime lease', 409);
  }
  return { workerId, epoch };
}

export async function claimScheduledAction(client, {
  worldId, scheduledActionId, workerId, leaseEpoch, actorEntityId, now = new Date().toISOString(),
}) {
  await actorForSubject(client, worldId, actorEntityId, actorEntityId, { systemOnly: true });
  const nowIso = instant(now, 'now');
  const row = (await client.query(
    `SELECT * FROM runtime.scheduled_actions WHERE world_id=$1 AND scheduled_action_id=$2 FOR UPDATE`,
    [worldId, scheduledActionId],
  )).rows[0];
  if (!row) throw problem('SCHEDULED_ACTION_NOT_FOUND', 'scheduled action not found', 404);
  if (row.status !== 'SCHEDULED') throw problem('SCHEDULED_ACTION_NOT_CLAIMABLE', `scheduled action is ${row.status}`, 409);
  if (new Date(row.due_at) > new Date(nowIso)) throw problem('SCHEDULED_ACTION_NOT_DUE', 'scheduled action is not due yet', 409);
  const lease = await assertLease(client, worldId, row.subject_id, workerId, leaseEpoch);
  if (row.latest_run_at && new Date(nowIso) > new Date(row.latest_run_at) && row.missed_policy === 'SKIP') {
    const missed = (await client.query(
      `UPDATE runtime.scheduled_actions SET status='MISSED',updated_at=now() WHERE world_id=$1 AND scheduled_action_id=$2 RETURNING *`,
      [worldId, scheduledActionId],
    )).rows[0];
    await bumpState(client, worldId, row.subject_id);
    return { ...missed, claim_result: 'MISSED' };
  }
  const state = await lifecycle(client, worldId, row.subject_id, true);
  if (row.action_kind === 'AUTONOMOUS_TURN') {
    if ((state.restriction_flags ?? []).includes('M03_CONTEXT_UNAVAILABLE')) {
      const blocked = (await client.query(
        `UPDATE runtime.scheduled_actions SET status='BLOCKED',blocked_reason='M03_CONTEXT_UNAVAILABLE',updated_at=now()
          WHERE world_id=$1 AND scheduled_action_id=$2 RETURNING *`,
        [worldId, scheduledActionId],
      )).rows[0];
      await bumpState(client, worldId, row.subject_id);
      return { ...blocked, claim_result: 'BLOCKED_DEPENDENCY' };
    }
    const eligibility = await getExecutionEligibility(client, {
      worldId,
      agentEntityId: row.subject_id,
      billingDate: nowIso.slice(0, 10),
      actorEntityId,
    });
    if (!eligibility.can_autonomous_turn) {
      throw problem('RUNTIME_INELIGIBLE', `autonomous turn is not currently eligible: ${eligibility.reasons.join(',')}`, 409);
    }
  }
  const claimed = (await client.query(
    `UPDATE runtime.scheduled_actions
        SET status='CLAIMED',claimed_by_worker=$3,claimed_lease_epoch=$4,claimed_at=now(),updated_at=now()
      WHERE world_id=$1 AND scheduled_action_id=$2
      RETURNING *`,
    [worldId, scheduledActionId, lease.workerId, lease.epoch],
  )).rows[0];
  await bumpState(client, worldId, row.subject_id);
  return { ...claimed, claim_result: 'CLAIMED' };
}

export async function completeScheduledAction(client, {
  worldId, scheduledActionId, workerId, leaseEpoch, actorEntityId, outcome = 'COMPLETED', blockedReason = null,
}) {
  await actorForSubject(client, worldId, actorEntityId, actorEntityId, { systemOnly: true });
  if (!['COMPLETED','BLOCKED'].includes(outcome)) throw problem('INVALID_RUNTIME_INPUT', 'outcome must be COMPLETED or BLOCKED');
  const row = (await client.query(
    `SELECT * FROM runtime.scheduled_actions WHERE world_id=$1 AND scheduled_action_id=$2 FOR UPDATE`,
    [worldId, scheduledActionId],
  )).rows[0];
  if (!row) throw problem('SCHEDULED_ACTION_NOT_FOUND', 'scheduled action not found', 404);
  if (row.status !== 'CLAIMED') throw problem('SCHEDULED_ACTION_NOT_COMPLETABLE', `scheduled action is ${row.status}`, 409);
  const lease = await assertLease(client, worldId, row.subject_id, workerId, leaseEpoch);
  if (row.claimed_by_worker !== lease.workerId || String(row.claimed_lease_epoch) !== lease.epoch) {
    throw problem('STALE_RUNTIME_LEASE', 'claim belongs to a different worker/lease epoch', 409);
  }
  const reason = blockedReason === null ? null : text(blockedReason, 'blockedReason', 2000);
  const updated = (await client.query(
    `UPDATE runtime.scheduled_actions
        SET status=$3,blocked_reason=$4,completed_at=now(),updated_at=now()
      WHERE world_id=$1 AND scheduled_action_id=$2 RETURNING *`,
    [worldId, scheduledActionId, outcome, reason],
  )).rows[0];
  const stateVersion = await bumpState(client, worldId, row.subject_id);
  return { ...updated, state_version: stateVersion };
}

export async function listRuntimeControlState(client, { worldId, agentEntityId, actorEntityId }) {
  await actorForSubject(client, worldId, agentEntityId, actorEntityId);
  const transitions = (await client.query(
    `SELECT transition_id,from_life_status,to_life_status,reason,billing_date,state_version,created_by,created_at
       FROM runtime.lifecycle_transition_events WHERE world_id=$1 AND activity_subject_id=$2 ORDER BY created_at,transition_id`,
    [worldId, agentEntityId],
  )).rows;
  const traits = (await client.query(
    `SELECT trait_key,trait_class,value_ppm,version,updated_by,updated_at
       FROM runtime.trait_states WHERE world_id=$1 AND subject_id=$2 ORDER BY trait_key`,
    [worldId, agentEntityId],
  )).rows;
  const schedules = (await client.query(
    `SELECT * FROM runtime.scheduled_actions WHERE world_id=$1 AND subject_id=$2 ORDER BY due_at,priority DESC,scheduled_action_id`,
    [worldId, agentEntityId],
  )).rows;
  return { transitions, traits, scheduledActions: schedules };
}
