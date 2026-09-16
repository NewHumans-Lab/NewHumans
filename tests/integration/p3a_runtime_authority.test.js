import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';
import { registerConnectorP14, registerDescriptorP14 } from '../../src/services/p1_4.js';
import {
  acquireRuntimeLease,
  publishModelRoute,
  registerAgentRuntime,
  registerModelManifest,
  saveRuntimeCheckpoint,
} from '../../src/services/runtime.js';

const pool = createPool();
const world = 'p3a-runtime-authority-test';
let system;

async function reset() {
  await pool.query(`TRUNCATE
    runtime.goal_dependencies,runtime.goals,runtime.runtime_checkpoints,runtime.runtime_leases,runtime.model_change_events,runtime.model_routes,runtime.model_manifests,runtime.lifecycle_states,runtime.agent_profiles,
    gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,
    economy.resource_quotes,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities
    RESTART IDENTITY CASCADE`);
  system = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world,
    entityType: 'SYSTEM',
    displayId: 'system',
    name: 'System',
  }));
}

async function runtimeAgent(name) {
  const agent = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world,
    entityType: 'AGENT',
    displayId: `${name}-${crypto.randomUUID()}`,
    name,
    createdBy: system.entity_id,
  }, { actorEntityId: system.entity_id }));
  await withTransaction(pool, (client) => registerAgentRuntime(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    actorEntityId: system.entity_id,
  }));
  return agent;
}

async function gatewayManifest(agent, suffix) {
  return withTransaction(pool, async (client) => {
    const descriptor = await registerDescriptorP14(client, {
      worldId: world,
      actorEntityId: system.entity_id,
      descriptorKey: `authority-${suffix}`,
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
      samplingSettings: { temperature: 0.1 },
      actorEntityId: system.entity_id,
    });
    return { descriptor, connector, manifest };
  });
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('connector execution identity cannot drift in place while operational enablement remains mutable', async () => {
  const agent = await runtimeAgent('connector');
  const { connector } = await gatewayManifest(agent, 'connector');

  const disabled = await pool.query(
    `UPDATE gateway.connector_configs SET enabled=false WHERE world_id=$1 AND connector_id=$2 RETURNING enabled`,
    [world, connector.connector_id],
  );
  assert.equal(disabled.rows[0].enabled, false);
  await pool.query(
    `UPDATE gateway.connector_configs SET enabled=true WHERE world_id=$1 AND connector_id=$2`,
    [world, connector.connector_id],
  );

  await assert.rejects(
    () => pool.query(
      `UPDATE gateway.connector_configs SET base_url='http://127.0.0.1:11434/rebound/' WHERE world_id=$1 AND connector_id=$2`,
      [world, connector.connector_id],
    ),
    /connector execution identity is immutable/,
  );
  await assert.rejects(
    () => pool.query(
      `UPDATE gateway.connector_configs SET billing_mode='PLATFORM_PREPAID' WHERE world_id=$1 AND connector_id=$2`,
      [world, connector.connector_id],
    ),
    /connector execution identity is immutable/,
  );
});

test('database rejects cross-Agent manifest and route history even when service validation is bypassed', async () => {
  const agentA = await runtimeAgent('agent-a');
  const agentB = await runtimeAgent('agent-b');
  const { manifest } = await gatewayManifest(agentA, 'cross-agent');

  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.model_routes
        (world_id,agent_entity_id,route_version,manifest_id,route_policy,reason,created_by)
       VALUES ($1,$2,1,$3,'{}'::jsonb,'illegal cross-agent route',$4)`,
      [world, agentB.entity_id, manifest.manifest_id, system.entity_id],
    ),
    (error) => error.constraint === 'model_routes_manifest_same_agent_fkey',
  );

  const routeA = await withTransaction(pool, (client) => publishModelRoute(client, {
    worldId: world,
    agentEntityId: agentA.entity_id,
    manifestId: manifest.manifest_id,
    reason: 'valid route for agent A',
    actorEntityId: system.entity_id,
  }));

  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.model_change_events
        (world_id,agent_entity_id,from_route_id,to_route_id,reason,created_by)
       VALUES ($1,$2,NULL,$3,'illegal cross-agent change',$4)`,
      [world, agentB.entity_id, routeA.route.route_id, system.entity_id],
    ),
    (error) => error.constraint === 'model_change_events_to_route_same_agent_fkey',
  );
});

test('PostgreSQL checkpoint fence rejects stale epochs/version skips and advances the single lifecycle version', async () => {
  const agent = await runtimeAgent('checkpoint-db');
  const lease = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    workerId: 'worker-current',
    ttlSeconds: 60,
    actorEntityId: system.entity_id,
  }));

  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.runtime_checkpoints
        (world_id,activity_subject_id,lease_epoch,state_version)
       VALUES ($1,$2,999,2)`,
      [world, agent.entity_id],
    ),
    /current runtime lease fence/,
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO runtime.runtime_checkpoints
        (world_id,activity_subject_id,lease_epoch,state_version)
       VALUES ($1,$2,$3,3)`,
      [world, agent.entity_id, lease.lease_epoch],
    ),
    /runtime state-version fence/,
  );

  const direct = await pool.query(
    `INSERT INTO runtime.runtime_checkpoints
      (world_id,activity_subject_id,lease_epoch,state_version,current_plan)
     VALUES ($1,$2,$3,2,'{"source":"direct-authority-test"}'::jsonb)
     RETURNING checkpoint_id,state_version`,
    [world, agent.entity_id, lease.lease_epoch],
  );
  assert.equal(String(direct.rows[0].state_version), '2');
  const lifecycle = await pool.query(
    `SELECT state_version FROM runtime.lifecycle_states WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  );
  assert.equal(String(lifecycle.rows[0].state_version), '2');

  const serviceCheckpoint = await withTransaction(pool, (client) => saveRuntimeCheckpoint(client, {
    worldId: world,
    agentEntityId: agent.entity_id,
    workerId: 'worker-current',
    leaseEpoch: lease.lease_epoch,
    expectedStateVersion: '2',
    currentPlan: { source: 'service-after-direct' },
    actorEntityId: system.entity_id,
  }));
  assert.equal(String(serviceCheckpoint.state_version), '3');
});
