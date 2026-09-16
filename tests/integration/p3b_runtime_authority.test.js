import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';
import { mint } from '../../src/services/economy.js';
import { registerConnectorP14, registerDescriptorP14 } from '../../src/services/p1_4.js';
import {
  acquireRuntimeLease,
  publishModelRoute,
  registerAgentRuntime,
  registerModelManifest,
  releaseRuntimeLease,
} from '../../src/services/runtime.js';
import { completeScheduledAction, scheduleAction, setTrait } from '../../src/services/runtime_control.js';
import { claimAutonomousScheduledAction, recoverAutonomousScheduledClaim, resumeRuntime } from '../../src/services/runtime_policy.js';

const pool = createPool();
const world = 'p3b-authority-test';
let system;

async function reset() {
  await pool.query(`TRUNCATE
    runtime.trait_updates,runtime.trait_states,runtime.goal_revisions,runtime.scheduled_actions,runtime.lifecycle_transition_events,
    runtime.goal_dependencies,runtime.goals,runtime.runtime_checkpoints,runtime.runtime_leases,runtime.model_change_events,runtime.model_routes,runtime.model_manifests,runtime.lifecycle_states,runtime.agent_profiles,
    gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,
    economy.resource_quotes,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities
    RESTART IDENTITY CASCADE`);
  system = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world, entityType: 'SYSTEM', displayId: 'system', name: 'System',
  }));
}

async function agent(name, fund = '103000000') {
  const row = await withTransaction(pool, (client) => createEntity(client, {
    worldId: world, entityType: 'AGENT', displayId: `${name}-${crypto.randomUUID()}`, name, createdBy: system.entity_id,
  }, { actorEntityId: system.entity_id }));
  await withTransaction(pool, (client) => registerAgentRuntime(client, {
    worldId: world, agentEntityId: row.entity_id, actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => mint(client, {
    worldId: world, targetEntityId: row.entity_id, amountMicroE: fund,
    basisKey: `fund-${row.entity_id}`, actorEntityId: system.entity_id,
  }));
  return row;
}

async function installRoute(subject) {
  return withTransaction(pool, async (client) => {
    const suffix = crypto.randomUUID();
    const descriptor = await registerDescriptorP14(client, {
      worldId: world, actorEntityId: system.entity_id,
      descriptorKey: `authority-${suffix}`, modelReference: `model-${suffix}`,
      maxInputTokens: 4096, maxOutputTokens: 512, maxRetries: 0,
      supportsIdempotency: true, inputRateMicroEPerMillion: '1', outputRateMicroEPerMillion: '1',
    });
    const connector = await registerConnectorP14(client, {
      worldId: world, actorEntityId: system.entity_id, descriptorId: descriptor.descriptor_id,
      connectorKind: 'LOCAL_SELF_HOSTED', billingMode: 'BYOK', baseUrl: `http://127.0.0.1:11434/${suffix}/`,
    });
    const manifest = await registerModelManifest(client, {
      worldId: world, agentEntityId: subject.entity_id, descriptorId: descriptor.descriptor_id,
      connectorId: connector.connector_id, promptVersion: 'authority-v1', actorEntityId: system.entity_id,
    });
    return publishModelRoute(client, {
      worldId: world, agentEntityId: subject.entity_id, manifestId: manifest.manifest_id,
      reason: 'authority test route', actorEntityId: system.entity_id,
    });
  });
}

async function contextReady(subject) {
  await pool.query(
    `UPDATE runtime.lifecycle_states
        SET restriction_flags=array_remove(restriction_flags,'M03_CONTEXT_UNAVAILABLE'),state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, subject.entity_id],
  );
}

async function readyActive(name) {
  const subject = await agent(name);
  await installRoute(subject);
  await contextReady(subject);
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: subject.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  return subject;
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('database ACTIVE-state guard rejects M03 and policy-blocking restrictions even if service policy is bypassed', async () => {
  const subject = await readyActive('active-guard');
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.lifecycle_states SET restriction_flags=array_append(restriction_flags,'NO_BUDGET')
        WHERE world_id=$1 AND activity_subject_id=$2`,
      [world, subject.entity_id],
    ),
    /ACTIVE runtime cannot retain blocking restriction/,
  );
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.lifecycle_states SET restriction_flags=array_append(restriction_flags,'M03_CONTEXT_UNAVAILABLE')
        WHERE world_id=$1 AND activity_subject_id=$2`,
      [world, subject.entity_id],
    ),
    /ACTIVE runtime cannot retain blocking restriction/,
  );
});

test('trait state cannot advance without exactly one matching append-only evidence row', async () => {
  const subject = await agent('trait-evidence');
  await withTransaction(pool, (client) => setTrait(client, {
    worldId: world, subjectId: subject.entity_id, traitKey: 'learning.patience', traitClass: 'LEARNED', valuePpm: 300000,
    source: 'SELF_REFLECTION', rationale: 'baseline', actorEntityId: subject.entity_id,
  }));
  await assert.rejects(
    () => pool.query(
      `UPDATE runtime.trait_states SET value_ppm=400000,version=version+1
        WHERE world_id=$1 AND subject_id=$2 AND trait_key='learning.patience'`,
      [world, subject.entity_id],
    ),
    /requires exactly one matching append-only trait update/,
  );
  const current = (await pool.query(
    `SELECT value_ppm,version FROM runtime.trait_states WHERE world_id=$1 AND subject_id=$2 AND trait_key='learning.patience'`,
    [world, subject.entity_id],
  )).rows[0];
  assert.equal(current.value_ppm, 300000);
  assert.equal(String(current.version), '1');
});

test('scheduled action terms and legal status path are enforced by PostgreSQL', async () => {
  const subject = await agent('schedule-guard');
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: subject.entity_id, actionKind: 'WAKE', dueAt: '2026-09-16T00:00:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', budgetMicroE: '1000000', priority: 5,
    dedupeKey: 'guarded-wake', actorEntityId: subject.entity_id,
  }));
  await assert.rejects(
    () => pool.query(`UPDATE runtime.scheduled_actions SET budget_micro_e=2000000 WHERE scheduled_action_id=$1`, [scheduled.scheduled_action_id]),
    /scheduled action terms are immutable/,
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.scheduled_actions SET status='CLAIMED',claimed_by_worker='illegal',claimed_lease_epoch=1,claimed_at=now() WHERE scheduled_action_id=$1`, [scheduled.scheduled_action_id]),
    /scheduled action|WAKE|constraint/i,
  );
});

test('strictly newer current lease epoch can take over a stale autonomous claim and old worker remains fenced', async () => {
  const subject = await readyActive('claim-recovery');
  const lease1 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: subject.entity_id, workerId: 'worker-a', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: subject.entity_id, actionKind: 'AUTONOMOUS_TURN', dueAt: '2026-09-16T00:00:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', dedupeKey: 'recoverable-turn', actorEntityId: subject.entity_id,
  }));
  await withTransaction(pool, (client) => claimAutonomousScheduledAction(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch,
    now: '2026-09-16T01:00:00Z', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: subject.entity_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch, actorEntityId: system.entity_id,
  }));
  const lease2 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: subject.entity_id, workerId: 'worker-b', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));

  await assert.rejects(
    () => withTransaction(pool, (client) => completeScheduledAction(client, {
      worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch,
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'STALE_RUNTIME_LEASE',
  );
  const recovered = await withTransaction(pool, (client) => recoverAutonomousScheduledClaim(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-b', leaseEpoch: lease2.lease_epoch,
    actorEntityId: system.entity_id,
  }));
  assert.equal(recovered.recovery, true);
  assert.equal(recovered.claimed_by_worker, 'worker-b');
  assert.equal(String(recovered.claimed_lease_epoch), String(lease2.lease_epoch));

  await assert.rejects(
    () => withTransaction(pool, (client) => completeScheduledAction(client, {
      worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch,
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'STALE_RUNTIME_LEASE',
  );
  const completed = await withTransaction(pool, (client) => completeScheduledAction(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-b', leaseEpoch: lease2.lease_epoch,
    actorEntityId: system.entity_id,
  }));
  assert.equal(completed.status, 'COMPLETED');
});
