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
import { reconcileActiveRuntime, scheduleAction } from '../../src/services/runtime_control.js';
import { claimAutonomousScheduledAction, recoverAutonomousScheduledClaim, resumeRuntime } from '../../src/services/runtime_policy.js';
import { runDueWakeScheduledAction } from '../../src/services/runtime_scheduler.js';

const pool = createPool();
const world = 'p3-review-closure-test';
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
      descriptorKey: `review-${suffix}`, modelReference: `model-${suffix}`,
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
      connectorId: connector.connector_id, promptVersion: 'review-v1', samplingSettings: { temperature: 0.2 },
      actorEntityId: system.entity_id,
    });
    const route = await publishModelRoute(client, {
      worldId: world, agentEntityId: agent.entity_id, manifestId: manifest.manifest_id,
      routePolicy: { purposes: ['PRIMARY_INFERENCE'] }, reason: 'review closure route', actorEntityId: system.entity_id,
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
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: await currentUtcDate(), actorEntityId: system.entity_id,
  }));
  return { agent, ...model };
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('composite secret key names cannot persist in runtime JSON', async () => {
  const agent = await makeAgent('secrets');
  const descriptor = await withTransaction(pool, (client) => registerDescriptorP14(client, {
    worldId: world, actorEntityId: system.entity_id, descriptorKey: 'secret-desc', modelReference: 'secret-model',
    maxInputTokens: 100, maxOutputTokens: 10, maxRetries: 0,
    inputRateMicroEPerMillion: '1', outputRateMicroEPerMillion: '1',
  }));
  const connector = await withTransaction(pool, (client) => registerConnectorP14(client, {
    worldId: world, actorEntityId: system.entity_id, descriptorId: descriptor.descriptor_id,
    connectorKind: 'LOCAL_SELF_HOSTED', billingMode: 'BYOK', baseUrl: 'http://127.0.0.1:11434/secret/',
  }));
  for (const samplingSettings of [{ client_secret: 'x' }, { oauthPassword: 'x' }, { service_api_key: 'x' }]) {
    await assert.rejects(
      () => withTransaction(pool, (client) => registerModelManifest(client, {
        worldId: world, agentEntityId: agent.entity_id, descriptorId: descriptor.descriptor_id,
        connectorId: connector.connector_id, promptVersion: crypto.randomUUID(), samplingSettings,
        actorEntityId: system.entity_id,
      })),
      (error) => error.code === '23514' || error.code === 'SECRET_MATERIAL_FORBIDDEN',
    );
  }
});

test('same endpoint credential rotation uses canonical URL and one enabled connector', async () => {
  const descriptor = await withTransaction(pool, (client) => registerDescriptorP14(client, {
    worldId: world, actorEntityId: system.entity_id, descriptorKey: 'rotate-desc', modelReference: 'rotate-model',
    maxInputTokens: 100, maxOutputTokens: 10, maxRetries: 0,
    inputRateMicroEPerMillion: '1', outputRateMicroEPerMillion: '1',
  }));
  const first = await withTransaction(pool, (client) => registerConnectorP14(client, {
    worldId: world, actorEntityId: system.entity_id, descriptorId: descriptor.descriptor_id,
    connectorKind: 'LOCAL_SELF_HOSTED', billingMode: 'BYOK', baseUrl: 'http://127.0.0.1:11434/rotate/',
    credentialEnvKey: 'ROTATE_OLD_KEY',
  }));
  const second = await withTransaction(pool, (client) => registerConnectorP14(client, {
    worldId: world, actorEntityId: system.entity_id, replacesConnectorId: first.connector_id,
    baseUrl: 'http://127.0.0.1:11434/rotate', credentialEnvKey: 'ROTATE_NEW_KEY',
  }));
  assert.notEqual(second.connector_id, first.connector_id);
  const rows = (await pool.query(
    `SELECT connector_id,enabled FROM gateway.connector_configs WHERE world_id=$1 AND descriptor_id=$2 ORDER BY created_at`,
    [world, descriptor.descriptor_id],
  )).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.enabled).length, 1);
  assert.equal(rows.find((row) => row.connector_id === first.connector_id).enabled, false);
  assert.equal(rows.find((row) => row.connector_id === second.connector_id).enabled, true);
});

test('model route loss and identity suspension fail closed into DORMANT with evidence', async () => {
  const first = await readyActive('model-loss');
  await pool.query(`UPDATE gateway.connector_configs SET enabled=false WHERE world_id=$1 AND connector_id=$2`, [world, first.connector.connector_id]);
  let life = (await pool.query(
    `SELECT life_status,execution_status,model_status,dormant_reason FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, first.agent.entity_id],
  )).rows[0];
  assert.equal(life.life_status, 'DORMANT');
  assert.equal(life.execution_status, 'BLOCKED');
  assert.equal(life.model_status, 'TEMPORARILY_UNAVAILABLE');
  assert.equal(life.dormant_reason, 'MODEL_UNAVAILABLE');
  assert.equal((await pool.query(
    `SELECT count(*)::int n FROM runtime.lifecycle_transition_events WHERE world_id=$1 AND activity_subject_id=$2 AND from_life_status='ACTIVE' AND to_life_status='DORMANT'`,
    [world, first.agent.entity_id],
  )).rows[0].n, 1);

  const second = await readyActive('identity-loss');
  await pool.query(`UPDATE core.entities SET identity_status='SUSPENDED' WHERE world_id=$1 AND entity_id=$2`, [world, second.agent.entity_id]);
  life = (await pool.query(
    `SELECT life_status,execution_status,dormant_reason FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, second.agent.entity_id],
  )).rows[0];
  assert.equal(life.life_status, 'DORMANT');
  assert.equal(life.execution_status, 'BLOCKED');
  assert.equal(life.dormant_reason, 'IDENTITY_INACTIVE');
  const tomorrow = (await pool.query(`SELECT ((now() AT TIME ZONE 'UTC')::date + 1)::text d`)).rows[0].d;
  await withTransaction(pool, (client) => reconcileActiveRuntime(client, {
    worldId: world, agentEntityId: second.agent.entity_id, billingDate: tomorrow, actorEntityId: system.entity_id,
  }));
  assert.equal((await pool.query(
    `SELECT count(*)::int n FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`,
    [world, second.agent.entity_id, tomorrow],
  )).rows[0].n, 0);
});

test('lease ownership is immutable within an epoch and takeover cannot skip epochs', async () => {
  const agent = await makeAgent('lease-guard');
  const lease = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => pool.query(`UPDATE runtime.runtime_leases SET worker_id='worker-b' WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id]),
    /same-epoch runtime lease ownership is immutable/,
  );
  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', leaseEpoch: lease.lease_epoch, actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.runtime_leases SET worker_id='worker-c',lease_epoch=lease_epoch+2,acquired_at=now(),heartbeat_at=now(),expires_at=now()+interval '60 seconds',released_at=NULL
        WHERE world_id=$1 AND activity_subject_id=$2`,
      [world, agent.entity_id],
    ),
    /advance exactly one epoch/,
  );
});

test('claim takeover and terminal completion remain fenced by current eligibility and lease', async () => {
  const { agent, connector } = await readyActive('claim-fence');
  const lease1 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'AUTONOMOUS_TURN', dueAt: '2026-09-16T00:00:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', dedupeKey: 'claim-fence', actorEntityId: agent.entity_id,
  }));
  await withTransaction(pool, (client) => claimAutonomousScheduledAction(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch,
    actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch, actorEntityId: system.entity_id,
  }));
  const lease2 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-b', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => pool.query(`UPDATE runtime.scheduled_actions SET status='COMPLETED',completed_at=now() WHERE world_id=$1 AND scheduled_action_id=$2`, [world, scheduled.scheduled_action_id]),
    /current active runtime lease/,
  );
  await pool.query(`UPDATE gateway.connector_configs SET enabled=false WHERE world_id=$1 AND connector_id=$2`, [world, connector.connector_id]);
  await assert.rejects(
    () => withTransaction(pool, (client) => recoverAutonomousScheduledClaim(client, {
      worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-b', leaseEpoch: lease2.lease_epoch,
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'RUNTIME_INELIGIBLE' || error.code === '23514',
  );
});

test('WAKE cannot reach a terminal status without canonical scheduler evidence', async () => {
  const agent = await makeAgent('wake-evidence');
  await installRoute(agent, 'wake-evidence');
  await contextReady(agent);
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE', dueAt: '2026-09-16T00:00:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', dedupeKey: 'wake-evidence', actorEntityId: agent.entity_id,
  }));
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.scheduled_actions SET status='COMPLETED',claimed_by_worker='forged',claimed_at=now(),completed_at=now()
        WHERE world_id=$1 AND scheduled_action_id=$2`,
      [world, scheduled.scheduled_action_id],
    ),
    /authoritative scheduler execution evidence/,
  );
  const result = await withTransaction(pool, (client) => runDueWakeScheduledAction(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'wake-worker',
    billingDate: await currentUtcDate(), now: new Date().toISOString(), actorEntityId: system.entity_id,
  }));
  assert.equal(result.result, 'COMPLETED');
  assert.equal((await pool.query(
    `SELECT count(*)::int n FROM runtime.scheduled_wake_executions WHERE world_id=$1 AND scheduled_action_id=$2 AND outcome='COMPLETED'`,
    [world, scheduled.scheduled_action_id],
  )).rows[0].n, 1);
});

test('route provenance and checkpoint goal versions are database-authoritative', async () => {
  const agent = await makeAgent('authority');
  const { manifest } = await installRoute(agent, 'authority');
  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.model_routes (world_id,agent_entity_id,route_version,manifest_id,route_policy,reason,created_by)
       VALUES ($1,$2,999,$3,'{}'::jsonb,'forged authority',$2)`,
      [world, agent.entity_id, manifest.manifest_id],
    ),
    /ACTIVE SYSTEM authorization/,
  );
  const goal = await withTransaction(pool, (client) => createGoal(client, {
    worldId: world, subjectId: agent.entity_id, source: 'SELF', goalText: 'goal', actorEntityId: agent.entity_id,
  }));
  const lease = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'checkpoint-worker', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  const stateVersion = (await pool.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  )).rows[0].state_version;
  await assert.rejects(
    () => withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
      worldId: world, agentEntityId: agent.entity_id, workerId: 'checkpoint-worker', leaseEpoch: lease.lease_epoch,
      expectedStateVersion: stateVersion, goalRefs: [{ goal_id: goal.goal_id, version: null }], actorEntityId: system.entity_id,
    })),
    (error) => error.code === '23514',
  );
});