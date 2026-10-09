import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';
import { registerConnectorP14, registerDescriptorP14 } from '../../src/services/p1_4.js';
import {
  acquireRuntimeLease,
  createGoal,
  inspectAgentRuntime,
  publishModelRoute,
  registerAgentRuntime,
  registerModelManifest,
  releaseRuntimeLease,
  requestAutonomousTurn,
  saveRuntimeCheckpoint,
} from '../../src/services/runtime.js';

const pool = createPool();
const world = 'p3a-runtime-test';
let system;

async function reset() {
  await pool.query(`TRUNCATE
    runtime.goal_dependencies,runtime.goals,runtime.runtime_checkpoints,runtime.runtime_leases,runtime.model_change_events,runtime.model_routes,runtime.model_manifests,runtime.lifecycle_states,runtime.agent_profiles,
    gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,
    economy.resource_quotes,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities
    RESTART IDENTITY CASCADE`);
  system = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world, entityType: 'SYSTEM', displayId: 'system', name: 'System',
  }));
}

async function entity(type, name, worldId = world, creator = system) {
  return withTransaction(pool, (client) => createEntity(client, {
    worldId,
    entityType: type,
    displayId: `${name}-${crypto.randomUUID()}`,
    name,
    createdBy: creator?.entity_id ?? null,
  }, { actorEntityId: creator?.entity_id ?? null }));
}

async function runtimeAgent(name = 'agent') {
  const agent = await entity('AGENT', name);
  const runtime = await withTransaction(pool, (client) => registerAgentRuntime(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    actorEntityId: system.entity_id,
  }));
  return { agent, runtime };
}

async function gatewayManifest(agent, suffix = crypto.randomUUID()) {
  return withTransaction(pool, async (client) => {
    const descriptor = await registerDescriptorP14(client, {
      worldId: world,
      actorEntityId: system.entity_id,
      descriptorKey: `runtime-model-${suffix}`,
      version: 1,
      modelReference: `model-${suffix}`,
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      maxRetries: 1,
      supportsIdempotency: true,
      inputRateMicroEPerMillion: '1000',
      outputRateMicroEPerMillion: '2000',
    });
    const connector = await registerConnectorP14(client, {
      worldId: world,
      actorEntityId: system.entity_id,
      descriptorId: descriptor.descriptor_id,
      connectorKind: 'LOCAL_SELF_HOSTED',
      billingMode: 'BYOK',
      baseUrl: `http://127.0.0.1:11434/${suffix}/`,
    });
    const manifest = await registerModelManifest(client, {
      worldId: world,
      agentEntityId: agent.entity_id,
      descriptorId: descriptor.descriptor_id,
      connectorId: connector.connector_id,
      promptVersion: `prompt-${suffix}`,
      samplingSettings: { temperature: 0.2 },
      actorEntityId: system.entity_id,
    });
    return { descriptor, connector, manifest };
  });
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('M02 profile is authoritative for runtime state while M03 remains explicitly deferred', async () => {
  const human = await entity('HUMAN', 'human');
  await assert.rejects(
    () => withTransaction(pool, (client) => registerAgentRuntime(client, {
      worldId: world, agentEntityId: human.entity_id, actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'INVALID_RUNTIME_SUBJECT',
  );

  const { agent, runtime } = await runtimeAgent('registered');
  assert.equal(runtime.lifecycle.life_status, 'REGISTERED');
  assert.equal(runtime.lifecycle.execution_status, 'BLOCKED');
  assert.equal(runtime.lifecycle.model_status, 'TEMPORARILY_UNAVAILABLE');
  assert.deepEqual(new Set(runtime.lifecycle.restriction_flags), new Set(['M03_CONTEXT_UNAVAILABLE', 'NO_MODEL_ROUTE']));
  assert.equal(runtime.autonomousTurn.status, 'BLOCKED_DEPENDENCY');

  const snapshot = await withTransaction(pool, (client) => inspectAgentRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, actorEntityId: agent.entity_id,
  }));
  assert.equal(snapshot.profile.agent_entity_id, agent.entity_id);
  assert.equal(snapshot.autonomousTurn.m03Implementation, 'DEFERRED_BY_OWNER');
  assert.equal((await pool.query(`SELECT to_regnamespace('m03') IS NULL absent`)).rows[0].absent, true);
});

test('model switching appends immutable manifest/route history and moves one current-route pointer', async () => {
  const { agent } = await runtimeAgent('route');
  const first = await gatewayManifest(agent, 'one');
  const route1 = await withTransaction(pool, (client) => publishModelRoute(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    manifestId: first.manifest.manifest_id,
    routePolicy: { purposes: ['PRIMARY_INFERENCE'] },
    maxTurnBudgetMicroE: '500000',
    reason: 'initial route',
    actorEntityId: system.entity_id,
  }));
  assert.equal(String(route1.route.route_version), '1');
  assert.equal(route1.lifecycle.model_status, 'AVAILABLE');
  assert.equal(route1.lifecycle.restriction_flags.includes('NO_MODEL_ROUTE'), false);
  assert.equal(route1.lifecycle.restriction_flags.includes('M03_CONTEXT_UNAVAILABLE'), true);

  await assert.rejects(
    () => pool.query(`UPDATE runtime.model_manifests SET prompt_version='mutated' WHERE manifest_id=$1`, [first.manifest.manifest_id]),
    /append-only/,
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.model_routes SET reason='mutated' WHERE route_id=$1`, [route1.route.route_id]),
    /append-only/,
  );

  const afterFirstRoute = await withTransaction(pool, (client) => inspectAgentRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, actorEntityId: system.entity_id,
  }));
  const second = await gatewayManifest(agent, 'two');
  const route2 = await withTransaction(pool, (client) => publishModelRoute(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    manifestId: second.manifest.manifest_id,
    routePolicy: { purposes: ['PRIMARY_INFERENCE', 'AUXILIARY_INFERENCE'] },
    maxTurnBudgetMicroE: '600000',
    expectedProfileVersion: afterFirstRoute.profile.profile_version,
    reason: 'verified route change',
    actorEntityId: system.entity_id,
  }));
  assert.equal(String(route2.route.route_version), '2');

  const snapshot = await withTransaction(pool, (client) => inspectAgentRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, actorEntityId: system.entity_id,
  }));
  assert.equal(snapshot.profile.agent_entity_id, agent.entity_id);
  assert.equal(snapshot.profile.current_route_id, route2.route.route_id);
  assert.equal(snapshot.currentRoute.manifest_id, second.manifest.manifest_id);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM runtime.model_routes WHERE world_id=$1 AND agent_entity_id=$2`, [world, agent.entity_id])).rows[0].n, 2);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM runtime.model_change_events WHERE world_id=$1 AND agent_entity_id=$2`, [world, agent.entity_id])).rows[0].n, 2);
});

test('runtime policy and manifest metadata reject credential material', async () => {
  const { agent } = await runtimeAgent('secrets');
  const descriptor = await withTransaction(pool, (client) => registerDescriptorP14(client, {
    worldId: world,
    actorEntityId: system.entity_id,
    descriptorKey: 'secret-model',
    modelReference: 'secret-model',
    maxInputTokens: 4096,
    maxOutputTokens: 512,
    maxRetries: 0,
    inputRateMicroEPerMillion: '1',
    outputRateMicroEPerMillion: '1',
  }));
  const connector = await withTransaction(pool, (client) => registerConnectorP14(client, {
    worldId: world,
    actorEntityId: system.entity_id,
    descriptorId: descriptor.descriptor_id,
    connectorKind: 'LOCAL_SELF_HOSTED',
    billingMode: 'BYOK',
    baseUrl: 'http://127.0.0.1:11434/secrets/',
  }));
  await assert.rejects(
    () => withTransaction(pool, (client) => registerModelManifest(client, {
      worldId: world,
      agentEntityId: agent.entity_id,
      descriptorId: descriptor.descriptor_id,
      connectorId: connector.connector_id,
      promptVersion: 'p1',
      samplingSettings: { apiKey: 'must-not-persist' },
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'SECRET_MATERIAL_FORBIDDEN',
  );
});

test('lease epoch and state version fence stale workers from checkpoint writes', async () => {
  const { agent } = await runtimeAgent('lease');
  const lease1 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  assert.equal(String(lease1.lease_epoch), '1');
  const cp1 = await withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    workerId: 'worker-a',
    leaseEpoch: lease1.lease_epoch,
    expectedStateVersion: '1',
    currentPlan: { phase: 'registered' },
    pendingActions: [],
    actorEntityId: system.entity_id,
  }));
  assert.equal(String(cp1.state_version), '2');

  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch, actorEntityId: system.entity_id,
  }));
  const lease2 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-b', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  assert.equal(String(lease2.lease_epoch), '2');

  await assert.rejects(
    () => withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
      worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', leaseEpoch: '1', expectedStateVersion: '2', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'STALE_RUNTIME_LEASE',
  );
  const cp2 = await withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    workerId: 'worker-b',
    leaseEpoch: lease2.lease_epoch,
    expectedStateVersion: '2',
    eventCursor: { lastEvent: null },
    currentPlan: { phase: 'route-setup' },
    actorEntityId: system.entity_id,
  }));
  assert.equal(String(cp2.state_version), '3');
  await assert.rejects(
    () => withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
      worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-b', leaseEpoch: '2', expectedStateVersion: '2', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'STATE_VERSION_CONFLICT',
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.runtime_checkpoints SET current_plan='{}'::jsonb WHERE checkpoint_id=$1`, [cp1.checkpoint_id]),
    /append-only/,
  );
});

test('concurrent lease acquisition yields one current worker', async () => {
  const { agent } = await runtimeAgent('concurrent-lease');
  const attempts = await Promise.allSettled(['worker-a', 'worker-b'].map((workerId) => withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId, ttlSeconds: 60, actorEntityId: system.entity_id,
  }))));
  const fulfilled = attempts.filter((x) => x.status === 'fulfilled');
  const rejected = attempts.filter((x) => x.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'LEASE_HELD');
  const row = (await pool.query(`SELECT worker_id,lease_epoch FROM runtime.runtime_leases WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id])).rows[0];
  assert.equal(String(row.lease_epoch), '1');
});

test('goals persist under M02 authority while deferred owner/contract sources do not invent authorization', async () => {
  const { agent } = await runtimeAgent('goals');
  const root = await withTransaction(pool, (client) => createGoal(client, {
    worldId: world,
    subjectId: agent.entity_id,
    source: 'SELF',
    goalText: 'Create a reusable artifact',
    priority: 10,
    successEvidence: { kind: 'artifact_reference' },
    actorEntityId: agent.entity_id,
  }));
  assert.equal(String(root.state_version), '2');
  const child = await withTransaction(pool, (client) => createGoal(client, {
    worldId: world,
    subjectId: agent.entity_id,
    source: 'SELF',
    goalText: 'Prepare the artifact plan',
    priority: 20,
    parentGoalId: root.goal_id,
    dependencyGoalIds: [root.goal_id],
    actorEntityId: agent.entity_id,
  }));
  assert.equal(String(child.state_version), '3');
  assert.deepEqual(child.dependency_goal_ids, [root.goal_id]);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM runtime.goal_dependencies WHERE goal_id=$1`, [child.goal_id])).rows[0].n, 1);

  await assert.rejects(
    () => withTransaction(pool, (client) => createGoal(client, {
      worldId: world,
      subjectId: agent.entity_id,
      source: 'OWNER_DIRECTIVE',
      goalText: 'Pretend owner directive',
      actorEntityId: agent.entity_id,
    })),
    (error) => error.code === 'GOAL_SOURCE_DEFERRED',
  );
});

test('autonomous turn hard-stops before M05/M06 side effects while M03 is deferred', async () => {
  const { agent } = await runtimeAgent('blocked-turn');
  const model = await gatewayManifest(agent, 'blocked-turn');
  await withTransaction(pool, (client) => publishModelRoute(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    manifestId: model.manifest.manifest_id,
    reason: 'route ready but cognition dependency intentionally absent',
    actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => withTransaction(pool, (client) => requestAutonomousTurn(client, {
      worldId: world, agentEntityId: agent.entity_id, actorEntityId: agent.entity_id,
    })),
    (error) => error.code === 'M03_CONTEXT_UNAVAILABLE',
  );
  assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.executions WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM economy.reservations WHERE world_id=$1 AND entity_id=$2`, [world, agent.entity_id])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id])).rows[0].n, 0);
});
