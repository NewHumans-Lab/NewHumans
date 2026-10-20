import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';
import { mint } from '../../src/services/economy.js';
import { registerConnectorP14, registerDescriptorP14 } from '../../src/services/p1_4.js';
import {
  acquireRuntimeLease,
  createGoal,
  publishModelRoute,
  registerAgentRuntime,
  registerModelManifest,
  saveRuntimeCheckpoint,
} from '../../src/services/runtime.js';
import { scheduleAction } from '../../src/services/runtime_control.js';
import { resumeRuntime } from '../../src/services/runtime_policy.js';
import { runDueWakeScheduledAction } from '../../src/services/runtime_scheduler.js';

const pool = createPool();
const world = 'p3-final-review-edges';
let system;

async function reset() {
  await pool.query(`TRUNCATE
    runtime.scheduled_wake_executions,runtime.trait_updates,runtime.trait_states,runtime.goal_revisions,runtime.scheduled_actions,runtime.lifecycle_transition_events,
    runtime.goal_dependencies,runtime.goals,runtime.runtime_checkpoints,runtime.runtime_leases,runtime.model_change_events,runtime.model_routes,runtime.model_manifests,runtime.lifecycle_states,runtime.agent_profiles,
    gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,
    economy.resource_quotes,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities
    RESTART IDENTITY CASCADE`);
  system = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world, entityType: 'SYSTEM', displayId: 'system', name: 'System',
  }));
}

async function makeAgent(name, fund = '103000000') {
  const agent = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world, entityType: 'AGENT', displayId: `${name}-${crypto.randomUUID()}`,
    name, createdBy: system.entity_id,
  }, { actorEntityId: system.entity_id }));
  await withTransaction(pool, (client) => registerAgentRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, actorEntityId: system.entity_id,
  }));
  if (fund !== null) await withTransaction(pool, (client) => mint(client, {
    worldId: world, targetEntityId: agent.entity_id, amountMicroE: fund,
    basisKey: `fund-${agent.entity_id}`, actorEntityId: system.entity_id,
  }));
  return agent;
}

async function descriptorConnector(suffix) {
  return withTransaction(pool, async (client) => {
    const descriptor = await registerDescriptorP14(client, {
      worldId: world, actorEntityId: system.entity_id,
      descriptorKey: `edge-${suffix}`, modelReference: `model-${suffix}`,
      maxInputTokens: 4096, maxOutputTokens: 512, maxRetries: 0,
      supportsIdempotency: true, inputRateMicroEPerMillion: '1', outputRateMicroEPerMillion: '1',
    });
    const connector = await registerConnectorP14(client, {
      worldId: world, actorEntityId: system.entity_id, descriptorId: descriptor.descriptor_id,
      connectorKind: 'LOCAL_SELF_HOSTED', billingMode: 'BYOK',
      baseUrl: `http://127.0.0.1:11434/${suffix}/`,
    });
    return { descriptor, connector };
  });
}

async function installInitialRoute(agent, suffix, samplingSettings = { temperature: 0.2 }) {
  const gateway = await descriptorConnector(suffix);
  const manifest = await withTransaction(pool, (client) => registerModelManifest(client, {
    worldId: world, agentEntityId: agent.entity_id, descriptorId: gateway.descriptor.descriptor_id,
    connectorId: gateway.connector.connector_id, promptVersion: `p-${suffix}`, samplingSettings,
    actorEntityId: system.entity_id,
  }));
  const result = await withTransaction(pool, (client) => publishModelRoute(client, {
    worldId: world, agentEntityId: agent.entity_id, manifestId: manifest.manifest_id,
    routePolicy: { purposes: ['PRIMARY_INFERENCE'] }, reason: `route ${suffix}`, actorEntityId: system.entity_id,
  }));
  return { ...gateway, manifest, route: result.route };
}

async function currentUtcDate() {
  return (await pool.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text d`)).rows[0].d;
}

async function contextReady(agent) {
  await pool.query(
    `UPDATE runtime.lifecycle_states
        SET restriction_flags=array_remove(restriction_flags,'M03_CONTEXT_UNAVAILABLE'),state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  );
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('ordinary Basic-prefixed text is allowed while credential-shaped Basic auth remains forbidden', async () => {
  const agent = await makeAgent('basic');
  await installInitialRoute(agent, 'basic-text', { instruction: 'Basic inference mode' });
  const gateway = await descriptorConnector('basic-secret');
  await assert.rejects(
    () => withTransaction(pool, (client) => registerModelManifest(client, {
      worldId: world, agentEntityId: agent.entity_id, descriptorId: gateway.descriptor.descriptor_id,
      connectorId: gateway.connector.connector_id, promptVersion: 'basic-secret',
      samplingSettings: { note: 'Basic dXNlcjpwYXNz' }, actorEntityId: system.entity_id,
    })),
    (error) => error.code === '23514' || error.code === 'SECRET_MATERIAL_FORBIDDEN',
  );
});

test('checkpoint goal refs reject extra fields and oversized versions as validation errors', async () => {
  const agent = await makeAgent('goal-ref');
  await installInitialRoute(agent, 'goal-ref');
  const goal = await withTransaction(pool, (client) => createGoal(client, {
    worldId: world, subjectId: agent.entity_id, source: 'SYSTEM_OBLIGATION', goalText: 'strict snapshot', actorEntityId: system.entity_id,
  }));
  const lease = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'goal-ref-worker', actorEntityId: system.entity_id,
  }));
  const state = (await pool.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  )).rows[0];
  for (const goalRefs of [
    [{ goal_id: goal.goal_id, version: goal.version, credential: 'x' }],
    [{ goal_id: goal.goal_id, version: '999999999999999999999999999999999999999999' }],
  ]) {
    await assert.rejects(
      () => withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
        worldId: world, agentEntityId: agent.entity_id, workerId: 'goal-ref-worker', leaseEpoch: lease.lease_epoch,
        expectedStateVersion: state.state_version, goalRefs, actorEntityId: system.entity_id,
      })),
      (error) => error.code === '23514',
    );
  }
});

test('direct WAKE BLOCKED evidence must match an authoritative runtime blocking condition', async () => {
  const agent = await makeAgent('wake-block');
  await installInitialRoute(agent, 'wake-block');
  await contextReady(agent);
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE',
    dueAt: new Date(Date.now() - 60_000).toISOString(), dedupeKey: 'wake-block', actorEntityId: system.entity_id,
  }));
  const state = (await pool.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  )).rows[0];
  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.scheduled_wake_executions
        (world_id,scheduled_action_id,subject_id,outcome,worker_id,lifecycle_state_version,blocked_reason,created_by)
       VALUES ($1,$2,$3,'BLOCKED','forged-worker',$4,'RUNTIME_RESTRICTED',$5)`,
      [world, scheduled.scheduled_action_id, agent.entity_id, state.state_version, system.entity_id],
    ),
    (error) => error.code === '23514' && /does not match runtime restrictions/i.test(error.message),
  );
});

test('AUTONOMOUS_TURN cannot be consumed pre-claim without current lease and policy evidence', async () => {
  const agent = await makeAgent('auto-preclaim');
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'AUTONOMOUS_TURN',
    dueAt: new Date(Date.now() - 60_000).toISOString(), missedPolicy: 'RUN_ONCE',
    dedupeKey: 'auto-preclaim', actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.scheduled_actions SET status='BLOCKED',blocked_reason='M03_CONTEXT_UNAVAILABLE',updated_at=now()
        WHERE world_id=$1 AND scheduled_action_id=$2`,
      [world, scheduled.scheduled_action_id],
    ),
    (error) => error.code === '23514' && /active runtime lease/i.test(error.message),
  );
});

test('publishing a replacement route leaves an ACTIVE quiescent runtime executable', async () => {
  const agent = await makeAgent('route-replace');
  await installInitialRoute(agent, 'route-replace-1');
  await contextReady(agent);
  const date = await currentUtcDate();
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: date, actorEntityId: system.entity_id,
  }));
  const profile = (await pool.query(
    `SELECT profile_version FROM runtime.agent_profiles WHERE world_id=$1 AND agent_entity_id=$2`,
    [world, agent.entity_id],
  )).rows[0];
  const gateway = await descriptorConnector('route-replace-2');
  const manifest = await withTransaction(pool, (client) => registerModelManifest(client, {
    worldId: world, agentEntityId: agent.entity_id, descriptorId: gateway.descriptor.descriptor_id,
    connectorId: gateway.connector.connector_id, promptVersion: 'replace-2', samplingSettings: {}, actorEntityId: system.entity_id,
  }));
  const result = await withTransaction(pool, (client) => publishModelRoute(client, {
    worldId: world, agentEntityId: agent.entity_id, manifestId: manifest.manifest_id,
    expectedProfileVersion: profile.profile_version, routePolicy: {}, reason: 'active replacement', actorEntityId: system.entity_id,
  }));
  assert.equal(result.lifecycle.life_status, 'ACTIVE');
  assert.equal(result.lifecycle.execution_status, 'IDLE');
});

test('WAKE ignores caller billingDate and charges the database current UTC day', async () => {
  const agent = await makeAgent('wake-date');
  await installInitialRoute(agent, 'wake-date');
  await contextReady(agent);
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE',
    dueAt: new Date(Date.now() - 60_000).toISOString(), dedupeKey: 'wake-date', actorEntityId: system.entity_id,
  }));
  const current = await currentUtcDate();
  const result = await withTransaction(pool, (client) => runDueWakeScheduledAction(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'wake-date-worker',
    billingDate: '2000-01-01', now: '2099-01-01T00:00:00Z', actorEntityId: system.entity_id,
  }));
  assert.equal(result.result, 'COMPLETED');
  assert.equal(
    (await pool.query(
      `SELECT count(*)::int n FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`,
      [world, agent.entity_id, current],
    )).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query(
      `SELECT count(*)::int n FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date='2000-01-01'`,
      [world, agent.entity_id],
    )).rows[0].n,
    0,
  );
});
