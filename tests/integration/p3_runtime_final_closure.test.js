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
  releaseRuntimeLease,
  saveRuntimeCheckpoint,
} from '../../src/services/runtime.js';
import { scheduleAction } from '../../src/services/runtime_control.js';
import { claimAutonomousScheduledAction, recoverAutonomousScheduledClaim, resumeRuntime } from '../../src/services/runtime_policy.js';
import { runDueWakeScheduledAction } from '../../src/services/runtime_scheduler.js';

const pool = createPool();
const world = 'p3-final-closure-test';
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

async function installRoute(agent, suffix = crypto.randomUUID()) {
  return withTransaction(pool, async (client) => {
    const descriptor = await registerDescriptorP14(client, {
      worldId: world, actorEntityId: system.entity_id,
      descriptorKey: `final-${suffix}`, modelReference: `model-${suffix}`,
      maxInputTokens: 4096, maxOutputTokens: 512, maxRetries: 0,
      supportsIdempotency: true, inputRateMicroEPerMillion: '1', outputRateMicroEPerMillion: '1',
    });
    const connector = await registerConnectorP14(client, {
      worldId: world, actorEntityId: system.entity_id, descriptorId: descriptor.descriptor_id,
      connectorKind: 'LOCAL_SELF_HOSTED', billingMode: 'BYOK',
      baseUrl: `http://127.0.0.1:11434/${suffix}/`,
    });
    const manifest = await registerModelManifest(client, {
      worldId: world, agentEntityId: agent.entity_id, descriptorId: descriptor.descriptor_id,
      connectorId: connector.connector_id, promptVersion: 'final-v1', samplingSettings: { temperature: 0.2 },
      actorEntityId: system.entity_id,
    });
    const route = await publishModelRoute(client, {
      worldId: world, agentEntityId: agent.entity_id, manifestId: manifest.manifest_id,
      routePolicy: { purposes: ['PRIMARY_INFERENCE'] }, reason: 'final closure route', actorEntityId: system.entity_id,
    });
    return { descriptor, connector, manifest, route };
  });
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

async function readyActive(name) {
  const agent = await makeAgent(name);
  const model = await installRoute(agent, name);
  await contextReady(agent);
  const date = await currentUtcDate();
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: date, actorEntityId: system.entity_id,
  }));
  return { agent, ...model };
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('route policy must remain a JSON object before provenance enrichment', async () => {
  const agent = await makeAgent('route-object');
  const { manifest } = await installRoute(agent, 'route-object');
  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.model_routes
        (world_id,agent_entity_id,route_version,manifest_id,route_policy,reason,created_by)
       VALUES ($1,$2,2,$3,'[]'::jsonb,'invalid scalar policy',$4)`,
      [world, agent.entity_id, manifest.manifest_id, system.entity_id],
    ),
    (error) => error.code === '23514' && /JSON object/i.test(error.message),
  );
});

test('checkpoint goal refs deduplicate canonical UUIDs rather than source casing', async () => {
  const agent = await makeAgent('goal-dedupe');
  await installRoute(agent, 'goal-dedupe');
  const goal = await withTransaction(pool, (client) => createGoal(client, {
    worldId: world, subjectId: agent.entity_id, source: 'SYSTEM_OBLIGATION', goalText: 'canonical goal',
    actorEntityId: system.entity_id,
  }));
  const lease = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'goal-worker', actorEntityId: system.entity_id,
  }));
  const state = (await pool.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  )).rows[0];
  await assert.rejects(
    () => withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
      worldId: world, agentEntityId: agent.entity_id, workerId: 'goal-worker', leaseEpoch: lease.lease_epoch,
      expectedStateVersion: state.state_version,
      goalRefs: [
        { goal_id: goal.goal_id, version: goal.version },
        { goal_id: goal.goal_id.toUpperCase(), version: goal.version },
      ],
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === '23514' && /duplicates/i.test(error.message),
  );
});

test('released lease cannot be revived inside the same fencing epoch', async () => {
  const agent = await makeAgent('lease-revival');
  const lease = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'lease-worker', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'lease-worker', leaseEpoch: lease.lease_epoch,
    actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.runtime_leases
          SET released_at=NULL,heartbeat_at=now(),expires_at=now()+interval '60 seconds'
        WHERE world_id=$1 AND activity_subject_id=$2`,
      [world, agent.entity_id],
    ),
    (error) => error.code === '23514' && /revived|renewed/i.test(error.message),
  );
});

test('future WAKE cannot be forged as MISSED by direct SQL evidence', async () => {
  const agent = await makeAgent('future-wake');
  const due = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const latest = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const schedule = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE', dueAt: due,
    missedPolicy: 'SKIP', latestRunAt: latest, dedupeKey: 'future-wake', actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.scheduled_wake_executions
        (world_id,scheduled_action_id,subject_id,outcome,worker_id,created_by)
       VALUES ($1,$2,$3,'MISSED','forged-worker',$4)`,
      [world, schedule.scheduled_action_id, agent.entity_id, system.entity_id],
    ),
    (error) => error.code === '23514' && /due time/i.test(error.message),
  );
});

test('WAKE against a suspended identity records BLOCKED instead of rolling back', async () => {
  const agent = await makeAgent('identity-wake');
  await installRoute(agent, 'identity-wake');
  await contextReady(agent);
  const schedule = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE',
    dueAt: new Date(Date.now() - 60_000).toISOString(), dedupeKey: 'identity-wake', actorEntityId: system.entity_id,
  }));
  await pool.query(
    `UPDATE core.entities SET identity_status='SUSPENDED' WHERE world_id=$1 AND entity_id=$2`,
    [world, agent.entity_id],
  );
  const result = await withTransaction(pool, (client) => runDueWakeScheduledAction(client, {
    worldId: world, scheduledActionId: schedule.scheduled_action_id, workerId: 'wake-worker',
    billingDate: new Date().toISOString().slice(0, 10), actorEntityId: system.entity_id,
  }));
  assert.equal(result.result, 'BLOCKED');
  assert.equal(result.reason, 'IDENTITY_NOT_ACTIVE');
  const stored = (await pool.query(
    `SELECT status,blocked_reason FROM runtime.scheduled_actions WHERE world_id=$1 AND scheduled_action_id=$2`,
    [world, schedule.scheduled_action_id],
  )).rows[0];
  assert.deepEqual(stored, { status: 'BLOCKED', blocked_reason: 'IDENTITY_NOT_ACTIVE' });
});

test('claim takeover reconciles the current UTC activity fee before eligibility', async () => {
  const { agent } = await readyActive('claim-fee');
  const date = await currentUtcDate();
  const lease1 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'claim-worker-1', actorEntityId: system.entity_id,
  }));
  const schedule = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'AUTONOMOUS_TURN',
    dueAt: new Date(Date.now() - 60_000).toISOString(), dedupeKey: 'claim-fee', actorEntityId: system.entity_id,
  }));
  const claimed = await withTransaction(pool, (client) => claimAutonomousScheduledAction(client, {
    worldId: world, scheduledActionId: schedule.scheduled_action_id, workerId: 'claim-worker-1',
    leaseEpoch: lease1.lease_epoch, actorEntityId: system.entity_id,
  }));
  assert.equal(claimed.claim_result, 'CLAIMED');
  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'claim-worker-1', leaseEpoch: lease1.lease_epoch,
    actorEntityId: system.entity_id,
  }));
  const lease2 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'claim-worker-2', actorEntityId: system.entity_id,
  }));

  // Preserve the immutable ledger journal while removing only the derived daily-fee
  // evidence row. The reconciliation must restore it idempotently before takeover.
  await pool.query(
    `DELETE FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`,
    [world, agent.entity_id, date],
  );
  const recovered = await withTransaction(pool, (client) => recoverAutonomousScheduledClaim(client, {
    worldId: world, scheduledActionId: schedule.scheduled_action_id, workerId: 'claim-worker-2',
    leaseEpoch: lease2.lease_epoch, actorEntityId: system.entity_id,
  }));
  assert.equal(recovered.recovery, true);
  assert.equal(recovered.claimed_by_worker, 'claim-worker-2');
  assert.equal(
    (await pool.query(
      `SELECT count(*)::int n FROM economy.activity_fees
        WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3 AND status='CHARGED'`,
      [world, agent.entity_id, date],
    )).rows[0].n,
    1,
  );
});
