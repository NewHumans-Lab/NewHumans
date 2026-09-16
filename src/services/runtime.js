import { withTransaction } from '../db.js';
import { appendEvent, resolveActor } from './core.js';

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function positiveSafeInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw problem('INVALID_RUNTIME_INPUT', `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalMicroE(value, field = 'amount') {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw problem('INVALID_AMOUNT', `${field} must be a non-negative decimal integer string`);
  return text;
}

function nonEmptyText(value, field, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw problem('INVALID_RUNTIME_INPUT', `${field} must be non-empty text up to ${max} characters`);
  }
  return value.trim();
}

function plainObject(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw problem('INVALID_RUNTIME_INPUT', `${field} must be an object`);
  return value;
}

function assertNoSecretMaterial(value, field) {
  const forbidden = /(api[_-]?key|secret|password|credential|access[_-]?token|bearer[_-]?token)/i;
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.test(key)) throw problem('SECRET_MATERIAL_FORBIDDEN', `${field} must not contain secret or credential material`);
      visit(child);
    }
  };
  visit(value);
}

async function assertSystem(client, worldId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'P3-A runtime control-plane mutation requires SYSTEM actor', 403);
  return actor;
}

async function assertProfile(client, worldId, agentEntityId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT world_id,agent_entity_id,memory_subject_id,current_route_id,profile_version,created_by,created_at,updated_at
       FROM runtime.agent_profiles
      WHERE world_id=$1 AND agent_entity_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [worldId, agentEntityId],
  );
  if (result.rowCount !== 1) throw problem('RUNTIME_PROFILE_NOT_FOUND', 'runtime profile not found', 404);
  return result.rows[0];
}

async function assertVisible(client, worldId, agentEntityId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM' && actor.entity_id !== agentEntityId) {
    throw problem('FORBIDDEN', 'runtime state is not visible to this actor', 403);
  }
  return actor;
}

async function bumpRuntimeState(client, worldId, agentEntityId) {
  const result = await client.query(
    `UPDATE runtime.lifecycle_states
        SET state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING state_version`,
    [worldId, agentEntityId],
  );
  if (result.rowCount !== 1) throw problem('RUNTIME_STATE_NOT_FOUND', 'runtime lifecycle state not found', 404);
  return result.rows[0].state_version;
}

export async function registerAgentRuntime(client, {
  worldId, agentEntityId, memorySubjectId = agentEntityId, actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  const entity = (await client.query(
    `SELECT entity_id,entity_type,identity_status FROM core.entities WHERE world_id=$1 AND entity_id=$2`,
    [worldId, agentEntityId],
  )).rows[0];
  if (!entity || entity.entity_type !== 'AGENT' || entity.identity_status !== 'ACTIVE') {
    throw problem('INVALID_RUNTIME_SUBJECT', 'runtime profile requires an active AGENT Entity', 409);
  }
  const memorySubject = (await client.query(
    `SELECT entity_id FROM core.entities WHERE world_id=$1 AND entity_id=$2`,
    [worldId, memorySubjectId],
  )).rows[0];
  if (!memorySubject) throw problem('INVALID_MEMORY_SUBJECT', 'memory subject must be an Entity in the same world', 409);
  const exists = await client.query(
    `SELECT 1 FROM runtime.agent_profiles WHERE world_id=$1 AND agent_entity_id=$2`,
    [worldId, agentEntityId],
  );
  if (exists.rowCount) throw problem('RUNTIME_PROFILE_EXISTS', 'runtime profile already exists', 409);

  const profile = (await client.query(
    `INSERT INTO runtime.agent_profiles (world_id,agent_entity_id,memory_subject_id,created_by)
     VALUES ($1,$2,$3,$4)
     RETURNING world_id,agent_entity_id,memory_subject_id,current_route_id,profile_version,created_at`,
    [worldId, agentEntityId, memorySubjectId, actorEntityId],
  )).rows[0];
  const lifecycle = (await client.query(
    `INSERT INTO runtime.lifecycle_states (world_id,activity_subject_id)
     VALUES ($1,$2)
     RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version,updated_at`,
    [worldId, agentEntityId],
  )).rows[0];
  if (actionId) await appendEvent(client, {
    worldId,
    aggregateType: 'RUNTIME_AGENT',
    aggregateId: agentEntityId,
    eventType: 'RUNTIME_PROFILE_REGISTERED',
    actorEntityId,
    actionId,
    payload: { memorySubjectId, m03ContextStatus: 'DEFERRED' },
  });
  return {
    profile,
    lifecycle,
    autonomousTurn: { status: 'BLOCKED_DEPENDENCY', dependency: 'M03_CONTEXT_PROVIDER' },
  };
}

export async function registerModelManifest(client, {
  worldId, agentEntityId, descriptorId, connectorId, promptVersion,
  samplingSettings = {}, artifactDigest = null, actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  await assertProfile(client, worldId, agentEntityId);
  promptVersion = nonEmptyText(promptVersion, 'promptVersion', 200);
  samplingSettings = plainObject(samplingSettings, 'samplingSettings');
  assertNoSecretMaterial(samplingSettings, 'samplingSettings');
  if (artifactDigest !== null && (typeof artifactDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(artifactDigest))) {
    throw problem('INVALID_RUNTIME_INPUT', 'artifactDigest must be a 64-character hex digest or null');
  }
  const gateway = (await client.query(
    `SELECT d.descriptor_id,d.version,d.provider_protocol,d.model_reference,d.assurance_level,d.verification_status,d.status descriptor_status,
            c.connector_id,c.connector_kind,c.billing_mode,c.enabled connector_enabled
       FROM gateway.capability_descriptors d
       JOIN gateway.connector_configs c ON c.world_id=d.world_id AND c.descriptor_id=d.descriptor_id
      WHERE d.world_id=$1 AND d.descriptor_id=$2 AND c.connector_id=$3`,
    [worldId, descriptorId, connectorId],
  )).rows[0];
  if (!gateway || gateway.descriptor_status !== 'ACTIVE' || !gateway.connector_enabled) {
    throw problem('MODEL_ROUTE_UNAVAILABLE', 'descriptor/connector pair is missing or unavailable', 409);
  }
  const manifest = (await client.query(
    `INSERT INTO runtime.model_manifests
      (world_id,agent_entity_id,gateway_descriptor_id,gateway_connector_id,descriptor_version,provider_protocol,model_reference,assurance_level,verification_status,connector_kind,billing_mode,prompt_version,sampling_settings,artifact_digest,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
     RETURNING manifest_id,world_id,agent_entity_id,gateway_descriptor_id,gateway_connector_id,descriptor_version,provider_protocol,model_reference,assurance_level,verification_status,connector_kind,billing_mode,prompt_version,sampling_settings,artifact_digest,created_at`,
    [worldId, agentEntityId, descriptorId, connectorId, gateway.version, gateway.provider_protocol, gateway.model_reference,
      gateway.assurance_level, gateway.verification_status, gateway.connector_kind, gateway.billing_mode, promptVersion,
      JSON.stringify(samplingSettings), artifactDigest, actorEntityId],
  )).rows[0];
  if (actionId) await appendEvent(client, {
    worldId,
    aggregateType: 'MODEL_MANIFEST',
    aggregateId: manifest.manifest_id,
    eventType: 'MODEL_MANIFEST_REGISTERED',
    actorEntityId,
    actionId,
    payload: {
      agentEntityId,
      descriptorId,
      connectorId,
      descriptorVersion: manifest.descriptor_version,
      modelReference: manifest.model_reference,
      promptVersion,
    },
  });
  return manifest;
}

export async function publishModelRoute(client, {
  worldId, agentEntityId, manifestId, routePolicy = {}, maxTurnBudgetMicroE = null,
  reason, actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  const profile = await assertProfile(client, worldId, agentEntityId, { lock: true });
  const currentLifecycle = (await client.query(
    `SELECT life_status,execution_status,state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (currentLifecycle?.execution_status === 'RUNNING') {
    throw problem('ROUTE_SWITCH_REQUIRES_QUIESCENCE', 'model route cannot change while the runtime is RUNNING', 409);
  }
  routePolicy = plainObject(routePolicy, 'routePolicy');
  assertNoSecretMaterial(routePolicy, 'routePolicy');
  reason = nonEmptyText(reason, 'reason', 2000);
  maxTurnBudgetMicroE = optionalMicroE(maxTurnBudgetMicroE, 'maxTurnBudgetMicroE');
  const manifest = (await client.query(
    `SELECT m.*,d.status descriptor_status,c.enabled connector_enabled,c.descriptor_id connector_descriptor_id
       FROM runtime.model_manifests m
       JOIN gateway.capability_descriptors d ON d.world_id=m.world_id AND d.descriptor_id=m.gateway_descriptor_id
       JOIN gateway.connector_configs c ON c.world_id=m.world_id AND c.connector_id=m.gateway_connector_id
      WHERE m.world_id=$1 AND m.manifest_id=$2 AND m.agent_entity_id=$3`,
    [worldId, manifestId, agentEntityId],
  )).rows[0];
  if (!manifest) throw problem('MODEL_MANIFEST_NOT_FOUND', 'model manifest not found for this Agent', 404);
  if (manifest.descriptor_status !== 'ACTIVE' || !manifest.connector_enabled || manifest.connector_descriptor_id !== manifest.gateway_descriptor_id) {
    throw problem('MODEL_ROUTE_UNAVAILABLE', 'manifest gateway route is no longer available', 409);
  }
  const next = (await client.query(
    `SELECT COALESCE(MAX(route_version),0)+1 next_version
       FROM runtime.model_routes WHERE world_id=$1 AND agent_entity_id=$2`,
    [worldId, agentEntityId],
  )).rows[0].next_version;
  const route = (await client.query(
    `INSERT INTO runtime.model_routes
      (world_id,agent_entity_id,route_version,manifest_id,route_policy,max_turn_budget_micro_e,reason,created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     RETURNING route_id,world_id,agent_entity_id,route_version,manifest_id,route_policy,max_turn_budget_micro_e,reason,created_at`,
    [worldId, agentEntityId, next, manifestId, JSON.stringify(routePolicy), maxTurnBudgetMicroE, reason, actorEntityId],
  )).rows[0];
  await client.query(
    `UPDATE runtime.agent_profiles
        SET current_route_id=$3,profile_version=profile_version+1,updated_at=now()
      WHERE world_id=$1 AND agent_entity_id=$2`,
    [worldId, agentEntityId, route.route_id],
  );
  const lifecycle = (await client.query(
    `UPDATE runtime.lifecycle_states
        SET model_status='AVAILABLE',
            execution_status='BLOCKED',
            restriction_flags=array_remove(restriction_flags,'NO_MODEL_ROUTE'),
            state_version=state_version+1,
            updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING life_status,execution_status,model_status,restriction_flags,archive_status,state_version`,
    [worldId, agentEntityId],
  )).rows[0];
  const change = (await client.query(
    `INSERT INTO runtime.model_change_events
      (world_id,agent_entity_id,from_route_id,to_route_id,reason,action_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING model_change_id,from_route_id,to_route_id,created_at`,
    [worldId, agentEntityId, profile.current_route_id, route.route_id, reason, actionId ?? null, actorEntityId],
  )).rows[0];
  if (actionId) await appendEvent(client, {
    worldId,
    aggregateType: 'RUNTIME_AGENT',
    aggregateId: agentEntityId,
    eventType: 'MODEL_ROUTE_PUBLISHED',
    actorEntityId,
    actionId,
    payload: {
      fromRouteId: profile.current_route_id,
      toRouteId: route.route_id,
      routeVersion: route.route_version,
      manifestId,
      stateVersion: lifecycle.state_version,
    },
  });
  return {
    route,
    modelChange: change,
    lifecycle,
    autonomousTurn: { status: 'BLOCKED_DEPENDENCY', dependency: 'M03_CONTEXT_PROVIDER' },
  };
}

function ttlSeconds(value) {
  return positiveSafeInt(value ?? 60, 'ttlSeconds', { min: 5, max: 3600 });
}

export async function acquireRuntimeLease(client, {
  worldId, agentEntityId, workerId, ttlSeconds: ttlInput = 60, actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  workerId = nonEmptyText(workerId, 'workerId', 200);
  const ttl = ttlSeconds(ttlInput);
  await assertProfile(client, worldId, agentEntityId);
  await client.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  );
  const current = (await client.query(
    `SELECT worker_id,lease_epoch,expires_at,released_at FROM runtime.runtime_leases
      WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (current && !current.released_at && new Date(current.expires_at).getTime() > Date.now()) {
    throw problem('LEASE_HELD', `runtime lease is already held by ${current.worker_id}`, 409);
  }
  const epoch = current ? (BigInt(current.lease_epoch) + 1n).toString() : '1';
  const lease = (await client.query(
    `INSERT INTO runtime.runtime_leases
      (world_id,activity_subject_id,worker_id,lease_epoch,acquired_at,heartbeat_at,expires_at,released_at)
     VALUES ($1,$2,$3,$4,now(),now(),now()+($5::text||' seconds')::interval,NULL)
     ON CONFLICT (world_id,activity_subject_id) DO UPDATE
       SET worker_id=EXCLUDED.worker_id,lease_epoch=EXCLUDED.lease_epoch,acquired_at=now(),heartbeat_at=now(),expires_at=EXCLUDED.expires_at,released_at=NULL
     RETURNING worker_id,lease_epoch,acquired_at,heartbeat_at,expires_at,released_at`,
    [worldId, agentEntityId, workerId, epoch, ttl],
  )).rows[0];
  if (actionId) await appendEvent(client, {
    worldId,
    aggregateType: 'RUNTIME_AGENT',
    aggregateId: agentEntityId,
    eventType: 'RUNTIME_LEASE_ACQUIRED',
    actorEntityId,
    actionId,
    payload: { workerId, leaseEpoch: lease.lease_epoch, expiresAt: lease.expires_at },
  });
  return lease;
}

export async function renewRuntimeLease(client, {
  worldId, agentEntityId, workerId, leaseEpoch, ttlSeconds: ttlInput = 60, actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  workerId = nonEmptyText(workerId, 'workerId', 200);
  const ttl = ttlSeconds(ttlInput);
  const epoch = String(leaseEpoch);
  if (!/^\d+$/.test(epoch) || BigInt(epoch) <= 0n) throw problem('INVALID_RUNTIME_INPUT', 'leaseEpoch must be a positive integer');
  await client.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  );
  const lease = (await client.query(
    `SELECT * FROM runtime.runtime_leases WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (!lease || lease.worker_id !== workerId || String(lease.lease_epoch) !== epoch || lease.released_at || new Date(lease.expires_at).getTime() <= Date.now()) {
    throw problem('STALE_RUNTIME_LEASE', 'runtime lease is missing, expired, released, or has a different epoch/worker', 409);
  }
  const updated = (await client.query(
    `UPDATE runtime.runtime_leases
        SET heartbeat_at=now(),expires_at=now()+($4::text||' seconds')::interval
      WHERE world_id=$1 AND activity_subject_id=$2 AND lease_epoch=$3
      RETURNING worker_id,lease_epoch,acquired_at,heartbeat_at,expires_at,released_at`,
    [worldId, agentEntityId, epoch, ttl],
  )).rows[0];
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: agentEntityId,
    eventType: 'RUNTIME_LEASE_RENEWED', actorEntityId, actionId,
    payload: { workerId, leaseEpoch: updated.lease_epoch, expiresAt: updated.expires_at },
  });
  return updated;
}

export async function releaseRuntimeLease(client, {
  worldId, agentEntityId, workerId, leaseEpoch, actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  workerId = nonEmptyText(workerId, 'workerId', 200);
  const epoch = String(leaseEpoch);
  if (!/^\d+$/.test(epoch) || BigInt(epoch) <= 0n) throw problem('INVALID_RUNTIME_INPUT', 'leaseEpoch must be a positive integer');
  const lease = (await client.query(
    `SELECT * FROM runtime.runtime_leases WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (!lease || lease.worker_id !== workerId || String(lease.lease_epoch) !== epoch || lease.released_at) {
    throw problem('STALE_RUNTIME_LEASE', 'runtime lease is missing, released, or has a different epoch/worker', 409);
  }
  const updated = (await client.query(
    `UPDATE runtime.runtime_leases SET released_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2
      RETURNING worker_id,lease_epoch,acquired_at,heartbeat_at,expires_at,released_at`,
    [worldId, agentEntityId],
  )).rows[0];
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: agentEntityId,
    eventType: 'RUNTIME_LEASE_RELEASED', actorEntityId, actionId,
    payload: { workerId, leaseEpoch: updated.lease_epoch },
  });
  return updated;
}

export async function saveRuntimeCheckpoint(client, {
  worldId, agentEntityId, workerId, leaseEpoch, expectedStateVersion,
  eventCursor = {}, currentPlan = {}, pendingActions = [], actorEntityId, actionId,
}) {
  await assertSystem(client, worldId, actorEntityId);
  workerId = nonEmptyText(workerId, 'workerId', 200);
  eventCursor = plainObject(eventCursor, 'eventCursor');
  currentPlan = plainObject(currentPlan, 'currentPlan');
  if (!Array.isArray(pendingActions)) throw problem('INVALID_RUNTIME_INPUT', 'pendingActions must be an array');
  const epoch = String(leaseEpoch);
  if (!/^\d+$/.test(epoch) || BigInt(epoch) <= 0n) throw problem('INVALID_RUNTIME_INPUT', 'leaseEpoch must be a positive integer');
  const expected = String(expectedStateVersion);
  if (!/^\d+$/.test(expected) || BigInt(expected) <= 0n) throw problem('INVALID_RUNTIME_INPUT', 'expectedStateVersion must be a positive integer');
  const state = (await client.query(
    `SELECT state_version FROM runtime.lifecycle_states
      WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (!state) throw problem('RUNTIME_STATE_NOT_FOUND', 'runtime lifecycle state not found', 404);
  const lease = (await client.query(
    `SELECT worker_id,lease_epoch,expires_at,released_at FROM runtime.runtime_leases
      WHERE world_id=$1 AND activity_subject_id=$2 FOR UPDATE`,
    [worldId, agentEntityId],
  )).rows[0];
  if (!lease || lease.worker_id !== workerId || String(lease.lease_epoch) !== epoch || lease.released_at || new Date(lease.expires_at).getTime() <= Date.now()) {
    throw problem('STALE_RUNTIME_LEASE', 'checkpoint writer does not hold the current active lease', 409);
  }
  if (String(state.state_version) !== expected) {
    throw problem('STATE_VERSION_CONFLICT', `expected runtime state ${expected} but current state is ${state.state_version}`, 409);
  }
  const nextVersion = (BigInt(expected) + 1n).toString();
  const checkpoint = (await client.query(
    `INSERT INTO runtime.runtime_checkpoints
      (world_id,activity_subject_id,lease_epoch,state_version,event_cursor,current_plan,pending_actions,state_summary)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
     RETURNING checkpoint_id,activity_subject_id,lease_epoch,state_version,event_cursor,current_plan,pending_actions,state_summary,created_at`,
    [worldId, agentEntityId, epoch, nextVersion, JSON.stringify(eventCursor), JSON.stringify(currentPlan), JSON.stringify(pendingActions),
      JSON.stringify({ m03Context: 'DEFERRED', autonomousTurn: 'BLOCKED_DEPENDENCY' })],
  )).rows[0];
  await client.query(
    `UPDATE runtime.lifecycle_states SET state_version=$3,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2`,
    [worldId, agentEntityId, nextVersion],
  );
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: agentEntityId,
    eventType: 'RUNTIME_CHECKPOINT_SAVED', actorEntityId, actionId,
    payload: { checkpointId: checkpoint.checkpoint_id, leaseEpoch: epoch, stateVersion: nextVersion },
  });
  return checkpoint;
}

export async function createGoal(client, {
  worldId, subjectId, source = 'SELF', goalText, priority = 0, rationale = null,
  budgetMicroE = null, deadline = null, parentGoalId = null, dependencyGoalIds = [],
  successEvidence = {}, actorEntityId, actionId,
}) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  await assertProfile(client, worldId, subjectId, { lock: true });
  if (source === 'SELF') {
    if (actor.entity_id !== subjectId) throw problem('FORBIDDEN', 'SELF goal must be created by the subject', 403);
  } else if (source === 'SYSTEM_OBLIGATION') {
    if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'SYSTEM_OBLIGATION requires SYSTEM actor', 403);
  } else if (source === 'OWNER_DIRECTIVE' || source === 'CONTRACT_OBLIGATION') {
    throw problem('GOAL_SOURCE_DEFERRED', `${source} authorization is not implemented until its owning module is integrated`, 409);
  } else {
    throw problem('INVALID_RUNTIME_INPUT', 'invalid goal source');
  }
  goalText = nonEmptyText(goalText, 'goalText');
  if (!Number.isSafeInteger(priority)) throw problem('INVALID_RUNTIME_INPUT', 'priority must be an integer');
  budgetMicroE = optionalMicroE(budgetMicroE, 'budgetMicroE');
  successEvidence = plainObject(successEvidence, 'successEvidence');
  if (!Array.isArray(dependencyGoalIds) || dependencyGoalIds.length > 100 || new Set(dependencyGoalIds).size !== dependencyGoalIds.length) {
    throw problem('INVALID_RUNTIME_INPUT', 'dependencyGoalIds must be a unique array of at most 100 goal IDs');
  }
  let deadlineValue = null;
  if (deadline !== null && deadline !== undefined) {
    const d = new Date(deadline);
    if (Number.isNaN(d.getTime())) throw problem('INVALID_RUNTIME_INPUT', 'deadline must be a valid timestamp');
    deadlineValue = d.toISOString();
  }
  const referenced = [parentGoalId, ...dependencyGoalIds].filter(Boolean);
  if (referenced.length) {
    const rows = await client.query(
      `SELECT goal_id FROM runtime.goals WHERE world_id=$1 AND subject_id=$2 AND goal_id = ANY($3::uuid[])`,
      [worldId, subjectId, referenced],
    );
    if (rows.rowCount !== new Set(referenced).size) throw problem('INVALID_GOAL_REFERENCE', 'parent/dependency goal must already exist for the same subject', 409);
  }
  const goal = (await client.query(
    `INSERT INTO runtime.goals
      (world_id,subject_id,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     RETURNING goal_id,world_id,subject_id,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,version,created_at,updated_at`,
    [worldId, subjectId, source, goalText, priority, rationale, budgetMicroE, deadlineValue, parentGoalId, JSON.stringify(successEvidence), actorEntityId],
  )).rows[0];
  for (const dependencyGoalId of dependencyGoalIds) {
    await client.query(
      `INSERT INTO runtime.goal_dependencies (world_id,subject_id,goal_id,depends_on_goal_id) VALUES ($1,$2,$3,$4)`,
      [worldId, subjectId, goal.goal_id, dependencyGoalId],
    );
  }
  const stateVersion = await bumpRuntimeState(client, worldId, subjectId);
  if (actionId) await appendEvent(client, {
    worldId, aggregateType: 'RUNTIME_AGENT', aggregateId: subjectId,
    eventType: 'GOAL_CREATED', actorEntityId, actionId,
    payload: { goalId: goal.goal_id, source, parentGoalId, dependencyGoalIds, stateVersion },
  });
  return { ...goal, dependency_goal_ids: dependencyGoalIds, state_version: stateVersion };
}

export async function requestAutonomousTurn(client, { worldId, agentEntityId, actorEntityId }) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM' && actor.entity_id !== agentEntityId) throw problem('FORBIDDEN', 'turn cannot be requested for another Agent', 403);
  await assertProfile(client, worldId, agentEntityId);
  throw problem(
    'M03_CONTEXT_UNAVAILABLE',
    'autonomous turn execution is intentionally blocked until an authoritative M03 context provider is adopted',
    409,
  );
}

export async function inspectAgentRuntime(client, { worldId, agentEntityId, actorEntityId }) {
  await assertVisible(client, worldId, agentEntityId, actorEntityId);
  const profile = await assertProfile(client, worldId, agentEntityId);
  const lifecycle = (await client.query(
    `SELECT life_status,execution_status,model_status,restriction_flags,archive_status,state_version,updated_at
       FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [worldId, agentEntityId],
  )).rows[0];
  const route = profile.current_route_id ? (await client.query(
    `SELECT r.*,m.gateway_descriptor_id,m.gateway_connector_id,m.descriptor_version,m.provider_protocol,m.model_reference,m.assurance_level,m.verification_status,m.connector_kind,m.billing_mode,m.prompt_version,m.sampling_settings,m.artifact_digest
       FROM runtime.model_routes r JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.manifest_id=r.manifest_id
      WHERE r.world_id=$1 AND r.route_id=$2`,
    [worldId, profile.current_route_id],
  )).rows[0] : null;
  const lease = (await client.query(
    `SELECT worker_id,lease_epoch,acquired_at,heartbeat_at,expires_at,released_at,
            (released_at IS NULL AND expires_at > now()) active
       FROM runtime.runtime_leases WHERE world_id=$1 AND activity_subject_id=$2`,
    [worldId, agentEntityId],
  )).rows[0] ?? null;
  const checkpoint = (await client.query(
    `SELECT checkpoint_id,lease_epoch,state_version,event_cursor,current_plan,pending_actions,state_summary,created_at
       FROM runtime.runtime_checkpoints WHERE world_id=$1 AND activity_subject_id=$2 ORDER BY state_version DESC LIMIT 1`,
    [worldId, agentEntityId],
  )).rows[0] ?? null;
  const goals = (await client.query(
    `SELECT goal_id,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,version,created_at,updated_at
       FROM runtime.goals WHERE world_id=$1 AND subject_id=$2 ORDER BY created_at,goal_id`,
    [worldId, agentEntityId],
  )).rows;
  return {
    profile,
    lifecycle,
    currentRoute: route,
    lease,
    latestCheckpoint: checkpoint,
    goals,
    autonomousTurn: {
      status: 'BLOCKED_DEPENDENCY',
      dependency: 'M03_CONTEXT_PROVIDER',
      m03Implementation: 'DEFERRED_BY_OWNER',
    },
  };
}

export async function getAgentRuntime(pool, input) {
  return withTransaction(pool, (client) => inspectAgentRuntime(client, input));
}
