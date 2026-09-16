import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';
import { firstActivation, getWallet, mint, transfer } from '../../src/services/economy.js';
import { registerConnectorP14, registerDescriptorP14 } from '../../src/services/p1_4.js';
import {
  acquireRuntimeLease,
  createGoal,
  publishModelRoute,
  registerAgentRuntime,
  registerModelManifest,
  releaseRuntimeLease,
} from '../../src/services/runtime.js';
import {
  completeScheduledAction,
  pauseRuntime,
  reconcileActiveRuntime,
  scheduleAction,
  setModelStatus,
  setTrait,
  updateGoal,
} from '../../src/services/runtime_control.js';
import {
  claimAutonomousScheduledAction,
  getRuntimeEligibility,
  resumeRuntime,
  setRuntimeRestriction,
} from '../../src/services/runtime_policy.js';
import { runDueWakeScheduledAction } from '../../src/services/runtime_scheduler.js';

const pool = createPool();
const world = 'p3b-runtime-test';
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

async function entity(type, name) {
  return withTransaction(pool, (client) => createEntity(client, {
    worldId: world,
    entityType: type,
    displayId: `${name}-${crypto.randomUUID()}`,
    name,
    createdBy: system.entity_id,
  }, { actorEntityId: system.entity_id }));
}

async function runtimeAgent(name, fundMicroE = null) {
  const agent = await entity('AGENT', name);
  await withTransaction(pool, (client) => registerAgentRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, actorEntityId: system.entity_id,
  }));
  if (fundMicroE !== null) {
    await withTransaction(pool, (client) => mint(client, {
      worldId: world,
      targetEntityId: agent.entity_id,
      amountMicroE: fundMicroE,
      basisKey: `fund-${agent.entity_id}`,
      actorEntityId: system.entity_id,
    }));
  }
  return agent;
}

async function installRoute(agent, suffix = crypto.randomUUID()) {
  return withTransaction(pool, async (client) => {
    const descriptor = await registerDescriptorP14(client, {
      worldId: world,
      actorEntityId: system.entity_id,
      descriptorKey: `p3b-${suffix}`,
      version: 1,
      modelReference: `model-${suffix}`,
      maxInputTokens: 4096,
      maxOutputTokens: 512,
      maxRetries: 0,
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
    const route = await publishModelRoute(client, {
      worldId: world,
      agentEntityId: agent.entity_id,
      manifestId: manifest.manifest_id,
      reason: 'P3-B test route',
      actorEntityId: system.entity_id,
    });
    return { descriptor, connector, manifest, route };
  });
}

async function adoptControlledContextStub(agent) {
  // Test-only dependency stub. Production has no API that removes this flag until M03 is adopted.
  await pool.query(
    `UPDATE runtime.lifecycle_states
        SET restriction_flags=array_remove(restriction_flags,'M03_CONTEXT_UNAVAILABLE'),state_version=state_version+1,updated_at=now()
      WHERE world_id=$1 AND activity_subject_id=$2`,
    [world, agent.entity_id],
  );
}

async function readyAgent(name, fundMicroE) {
  const agent = await runtimeAgent(name, fundMicroE);
  await installRoute(agent, name);
  await adoptControlledContextStub(agent);
  return agent;
}

async function feeCount(agent, date = null) {
  const query = date
    ? [`SELECT count(*)::int n FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`, [world, agent.entity_id, date]]
    : [`SELECT count(*)::int n FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id]];
  return (await pool.query(query[0], query[1])).rows[0].n;
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('M03 dependency blocks runtime activation before any daily fee or model execution side effect', async () => {
  const agent = await runtimeAgent('m03-block', '101000000');
  await installRoute(agent, 'm03-block');
  const before = await withTransaction(pool, (client) => getWallet(client, world, agent.entity_id));
  await assert.rejects(
    () => withTransaction(pool, (client) => resumeRuntime(client, {
      worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'M03_CONTEXT_UNAVAILABLE',
  );
  const after = await withTransaction(pool, (client) => getWallet(client, world, agent.entity_id));
  assert.equal(after.available_micro_e, before.available_micro_e);
  assert.equal(await feeCount(agent), 0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.executions WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id])).rows[0].n, 0);
});

test('trusted SYSTEM can initiate activity but unrelated Agent cannot; 100/101 post-fee thresholds are exact', async () => {
  const exact100 = await readyAgent('exact-100', '100000000');
  const exact101 = await readyAgent('exact-101', '101000000');
  const below = await readyAgent('below-100', '99999999');
  const stranger = await entity('AGENT', 'stranger');

  await assert.rejects(
    () => withTransaction(pool, (client) => firstActivation(client, {
      worldId: world, entityId: exact100.entity_id, billingDate: '2026-09-16', actorEntityId: stranger.entity_id,
    })),
    (error) => error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => withTransaction(pool, (client) => resumeRuntime(client, {
      worldId: world, agentEntityId: below.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'FIRST_ACTIVATION_MINIMUM_UNFUNDED',
  );
  assert.equal(await feeCount(below), 0);

  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: exact100.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: exact101.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  const e100 = await withTransaction(pool, (client) => getRuntimeEligibility(client, {
    worldId: world, agentEntityId: exact100.entity_id, billingDate: '2026-09-16', actorEntityId: exact100.entity_id,
  }));
  const e101 = await withTransaction(pool, (client) => getRuntimeEligibility(client, {
    worldId: world, agentEntityId: exact101.entity_id, billingDate: '2026-09-16', actorEntityId: exact101.entity_id,
  }));
  assert.equal(e100.available_micro_e, '99000000');
  assert.equal(e100.can_respond_inbound, true);
  assert.equal(e100.can_seek_tasks, false);
  assert.equal(e101.available_micro_e, '100000000');
  assert.equal(e101.can_seek_tasks, true);
  assert.equal(await feeCount(exact100, '2026-09-16'), 1);
  assert.equal(await feeCount(exact101, '2026-09-16'), 1);
});

test('DORMANT receives inbound without cognition, same-day resume does not double-charge, next-day wake charges once', async () => {
  const agent = await readyAgent('dormancy', '103000000');
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => pauseRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, reason: 'sleep now', actorEntityId: agent.entity_id,
  }));
  let eligibility = await withTransaction(pool, (client) => getRuntimeEligibility(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: agent.entity_id,
  }));
  assert.equal(eligibility.life_status, 'DORMANT');
  assert.equal(eligibility.can_receive_inbound, true);
  assert.equal(eligibility.can_respond_inbound, false);
  assert.equal(eligibility.can_autonomous_turn, false);

  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  assert.equal(await feeCount(agent, '2026-09-16'), 1);
  await withTransaction(pool, (client) => pauseRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, reason: 'overnight sleep', actorEntityId: agent.entity_id,
  }));
  assert.equal(await feeCount(agent, '2026-09-17'), 0);
  eligibility = await withTransaction(pool, (client) => getRuntimeEligibility(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-17', actorEntityId: agent.entity_id,
  }));
  assert.equal(eligibility.daily_fee_paid, false);
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-17', actorEntityId: system.entity_id,
  }));
  assert.equal(await feeCount(agent, '2026-09-17'), 1);
});

test('cross-day reconciliation charges once or moves an unfunded active runtime to DORMANT', async () => {
  const funded = await readyAgent('reconcile-funded', '103000000');
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: funded.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => reconcileActiveRuntime(client, {
    worldId: world, agentEntityId: funded.entity_id, billingDate: '2026-09-17', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => reconcileActiveRuntime(client, {
    worldId: world, agentEntityId: funded.entity_id, billingDate: '2026-09-17', actorEntityId: system.entity_id,
  }));
  assert.equal(await feeCount(funded, '2026-09-17'), 1);

  const poor = await readyAgent('reconcile-poor', '100000000');
  const sink = await entity('HUMAN', 'sink');
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: poor.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  await withTransaction(pool, (client) => transfer(client, {
    worldId: world, fromEntityId: poor.entity_id, toEntityId: sink.entity_id,
    amountMicroE: '98000000', businessKey: 'drain-poor', actorEntityId: poor.entity_id,
  }));
  const reconciled = await withTransaction(pool, (client) => reconcileActiveRuntime(client, {
    worldId: world, agentEntityId: poor.entity_id, billingDate: '2026-09-17', actorEntityId: system.entity_id,
  }));
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.lifecycle.life_status, 'DORMANT');
  assert.equal(reconciled.lifecycle.restriction_flags.includes('DAILY_FEE_UNFUNDED'), true);
  assert.equal(await feeCount(poor, '2026-09-17'), 0);
});

test('model recovery and funding never clear independent policy restrictions or auto-wake', async () => {
  const agent = await readyAgent('restrictions', '103000000');
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  const unavailable = await withTransaction(pool, (client) => setModelStatus(client, {
    worldId: world, agentEntityId: agent.entity_id, modelStatus: 'TEMPORARILY_UNAVAILABLE', reason: 'provider outage', actorEntityId: system.entity_id,
  }));
  assert.equal(unavailable.lifecycle.life_status, 'DORMANT');
  await withTransaction(pool, (client) => setRuntimeRestriction(client, {
    worldId: world, agentEntityId: agent.entity_id, restriction: 'OWNER_PAUSE', enabled: true, reason: 'owner pause authorization', actorEntityId: system.entity_id,
  }));
  const restored = await withTransaction(pool, (client) => setModelStatus(client, {
    worldId: world, agentEntityId: agent.entity_id, modelStatus: 'AVAILABLE', reason: 'provider recovered', actorEntityId: system.entity_id,
  }));
  assert.equal(restored.lifecycle.life_status, 'DORMANT');
  assert.equal(restored.lifecycle.restriction_flags.includes('OWNER_PAUSE'), true);
  await assert.rejects(
    () => withTransaction(pool, (client) => resumeRuntime(client, {
      worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'RUNTIME_RESTRICTED',
  );
  const cleared = await withTransaction(pool, (client) => setRuntimeRestriction(client, {
    worldId: world, agentEntityId: agent.entity_id, restriction: 'OWNER_PAUSE', enabled: false, reason: 'owner resumed permission', actorEntityId: system.entity_id,
  }));
  assert.equal(cleared.lifecycle.life_status, 'DORMANT');
  assert.equal(cleared.lifecycle.restriction_flags.includes('OWNER_PAUSE'), false);
});

test('goal mutations are optimistic, legally transitioned, versioned and append-only', async () => {
  const agent = await runtimeAgent('goal-version');
  const goal = await withTransaction(pool, (client) => createGoal(client, {
    worldId: world, subjectId: agent.entity_id, source: 'SELF', goalText: 'Build an artifact', actorEntityId: agent.entity_id,
  }));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM runtime.goal_revisions WHERE world_id=$1 AND goal_id=$2`, [world, goal.goal_id])).rows[0].n, 1);
  const active = await withTransaction(pool, (client) => updateGoal(client, {
    worldId: world, subjectId: agent.entity_id, goalId: goal.goal_id, expectedVersion: '1', status: 'ACTIVE',
    changeReason: 'start work', actorEntityId: agent.entity_id,
  }));
  assert.equal(String(active.version), '2');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM runtime.goal_revisions WHERE world_id=$1 AND goal_id=$2`, [world, goal.goal_id])).rows[0].n, 2);
  await assert.rejects(
    () => withTransaction(pool, (client) => updateGoal(client, {
      worldId: world, subjectId: agent.entity_id, goalId: goal.goal_id, expectedVersion: '1', status: 'PAUSED',
      changeReason: 'stale writer', actorEntityId: agent.entity_id,
    })),
    (error) => error.code === 'GOAL_VERSION_CONFLICT',
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.goals SET priority=priority+1 WHERE world_id=$1 AND goal_id=$2`, [world, goal.goal_id]),
    /goal version must advance exactly once/,
  );
  const completed = await withTransaction(pool, (client) => updateGoal(client, {
    worldId: world, subjectId: agent.entity_id, goalId: goal.goal_id, expectedVersion: '2', status: 'COMPLETED',
    changeReason: 'success evidence accepted', actorEntityId: agent.entity_id,
  }));
  assert.equal(String(completed.version), '3');
  await assert.rejects(
    () => withTransaction(pool, (client) => updateGoal(client, {
      worldId: world, subjectId: agent.entity_id, goalId: goal.goal_id, expectedVersion: '3', status: 'ACTIVE',
      changeReason: 'illegal reopen', actorEntityId: agent.entity_id,
    })),
    (error) => error.code === 'GOAL_TERMINAL',
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.goal_revisions SET change_reason='rewrite' WHERE world_id=$1 AND goal_id=$2`, [world, goal.goal_id]),
    /append-only/,
  );
});

test('trait current state is version fenced and cannot exist without matching immutable evidence', async () => {
  const agent = await runtimeAgent('traits');
  const birth = await withTransaction(pool, (client) => setTrait(client, {
    worldId: world, subjectId: agent.entity_id, traitKey: 'temperament.openness', traitClass: 'BIRTH', valuePpm: 700000,
    source: 'BIRTH_CONFIGURATION', rationale: 'initial configuration', actorEntityId: system.entity_id,
  }));
  assert.equal(String(birth.version), '1');
  await assert.rejects(
    () => withTransaction(pool, (client) => setTrait(client, {
      worldId: world, subjectId: agent.entity_id, traitKey: 'temperament.openness', traitClass: 'BIRTH', valuePpm: 710000, expectedVersion: '1',
      source: 'SYSTEM_POLICY', rationale: 'attempt to rewrite birth trait', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'BIRTH_TRAIT_IMMUTABLE',
  );
  const learned = await withTransaction(pool, (client) => setTrait(client, {
    worldId: world, subjectId: agent.entity_id, traitKey: 'strategy.caution', traitClass: 'LEARNED', valuePpm: 400000,
    source: 'SELF_REFLECTION', rationale: 'initial learned preference', actorEntityId: agent.entity_id,
  }));
  const updated = await withTransaction(pool, (client) => setTrait(client, {
    worldId: world, subjectId: agent.entity_id, traitKey: 'strategy.caution', traitClass: 'LEARNED', valuePpm: 500000, expectedVersion: learned.version,
    source: 'OBSERVED_OUTCOME', rationale: 'observed failure changed strategy', actorEntityId: agent.entity_id,
  }));
  assert.equal(String(updated.version), '2');
  await assert.rejects(
    () => withTransaction(pool, (client) => setTrait(client, {
      worldId: world, subjectId: agent.entity_id, traitKey: 'strategy.caution', traitClass: 'LEARNED', valuePpm: 600000, expectedVersion: '1',
      source: 'SELF_REFLECTION', rationale: 'stale update', actorEntityId: agent.entity_id,
    })),
    (error) => error.code === 'TRAIT_VERSION_CONFLICT',
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.trait_states SET value_ppm=600000 WHERE world_id=$1 AND subject_id=$2 AND trait_key='strategy.caution'`, [world, agent.entity_id]),
    /trait version must advance exactly once/,
  );
  await assert.rejects(
    () => pool.query(`UPDATE runtime.trait_updates SET rationale='rewrite' WHERE world_id=$1 AND subject_id=$2`, [world, agent.entity_id]),
    /append-only/,
  );
});

test('scheduled WAKE has one atomic path and M03 blocks before fee; adopted context allows one wake', async () => {
  const agent = await runtimeAgent('wake-schedule', '101000000');
  await installRoute(agent, 'wake-schedule');
  const blockedSchedule = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE', dueAt: '2026-09-16T00:00:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', dedupeKey: 'wake-m03-blocked', actorEntityId: agent.entity_id,
  }));
  await assert.rejects(
    () => withTransaction(pool, (client) => claimAutonomousScheduledAction(client, {
      worldId: world, scheduledActionId: blockedSchedule.scheduled_action_id, workerId: 'scheduler-a', leaseEpoch: '1', actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'WRONG_SCHEDULE_PATH',
  );
  const blocked = await withTransaction(pool, (client) => runDueWakeScheduledAction(client, {
    worldId: world, scheduledActionId: blockedSchedule.scheduled_action_id, workerId: 'scheduler-a',
    billingDate: '2026-09-16', now: '2026-09-16T01:00:00Z', actorEntityId: system.entity_id,
  }));
  assert.equal(blocked.result, 'BLOCKED');
  assert.equal(blocked.reason, 'M03_CONTEXT_UNAVAILABLE');
  assert.equal(await feeCount(agent), 0);

  await adoptControlledContextStub(agent);
  const runnable = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'WAKE', dueAt: '2026-09-16T01:30:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', dedupeKey: 'wake-ready', actorEntityId: agent.entity_id,
  }));
  const woke = await withTransaction(pool, (client) => runDueWakeScheduledAction(client, {
    worldId: world, scheduledActionId: runnable.scheduled_action_id, workerId: 'scheduler-a',
    billingDate: '2026-09-16', now: '2026-09-16T02:00:00Z', actorEntityId: system.entity_id,
  }));
  assert.equal(woke.result, 'COMPLETED');
  assert.equal(woke.lifecycle.life_status, 'ACTIVE');
  assert.equal(await feeCount(agent, '2026-09-16'), 1);
  await assert.rejects(
    () => pool.query(`UPDATE runtime.scheduled_actions SET status='CLAIMED',claimed_by_worker='x',claimed_lease_epoch=1,claimed_at=now() WHERE world_id=$1 AND scheduled_action_id=$2`, [world, runnable.scheduled_action_id]),
    /scheduled action|WAKE|status/i,
  );
});

test('autonomous schedule claim is lease fenced and stale worker cannot complete', async () => {
  const agent = await readyAgent('scheduled-turn', '103000000');
  await withTransaction(pool, (client) => resumeRuntime(client, {
    worldId: world, agentEntityId: agent.entity_id, billingDate: '2026-09-16', actorEntityId: system.entity_id,
  }));
  const lease1 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  const scheduled = await withTransaction(pool, (client) => scheduleAction(client, {
    worldId: world, subjectId: agent.entity_id, actionKind: 'AUTONOMOUS_TURN', dueAt: '2026-09-16T00:00:00Z',
    timezone: 'UTC', missedPolicy: 'RUN_ONCE', dedupeKey: 'turn-1', actorEntityId: agent.entity_id,
  }));
  const claim = await withTransaction(pool, (client) => claimAutonomousScheduledAction(client, {
    worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch,
    now: '2026-09-16T01:00:00Z', actorEntityId: system.entity_id,
  }));
  assert.equal(claim.status, 'CLAIMED');
  await withTransaction(pool, (client) => releaseRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch, actorEntityId: system.entity_id,
  }));
  const lease2 = await withTransaction(pool, (client) => acquireRuntimeLease(client, {
    worldId: world, agentEntityId: agent.entity_id, workerId: 'worker-b', ttlSeconds: 60, actorEntityId: system.entity_id,
  }));
  await assert.rejects(
    () => withTransaction(pool, (client) => completeScheduledAction(client, {
      worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-a', leaseEpoch: lease1.lease_epoch,
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'STALE_RUNTIME_LEASE',
  );
  await assert.rejects(
    () => withTransaction(pool, (client) => completeScheduledAction(client, {
      worldId: world, scheduledActionId: scheduled.scheduled_action_id, workerId: 'worker-b', leaseEpoch: lease2.lease_epoch,
      actorEntityId: system.entity_id,
    })),
    (error) => error.code === 'STALE_RUNTIME_LEASE',
  );
  assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.executions WHERE world_id=$1 AND activity_subject_id=$2`, [world, agent.entity_id])).rows[0].n, 0);
});
