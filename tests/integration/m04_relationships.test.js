import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import {
  appendRelationshipVersion,
  confirmMutualRelationship,
  getRelationshipHistory,
  proposeMutualRelationship,
  recordRelationship,
  toRelationshipContract,
} from '../../src/services/social_relationships.js';

const pool = createPool();
const relationshipSchema = JSON.parse(fs.readFileSync(new URL('../../schemas/relationship.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRelationship = ajv.compile(relationshipSchema);

async function reset() {
  await pool.query(`TRUNCATE
    social.relationship_versions,
    social.mutual_relationship_confirmations,
    social.mutual_relationship_proposals,
    social.relationships,
    core.consumer_receipts,
    core.outbox,
    core.life_events,
    economy.activity_fees,
    economy.activity_subjects,
    economy.reservations,
    economy.postings,
    economy.journals,
    economy.wallets,
    core.actions,
    core.capability_grants,
    core.entities
    RESTART IDENTITY CASCADE`);
}

async function entity(worldId, entityType, name, createdBy = null) {
  return withTransaction(pool, (client) => createEntity(
    client,
    { worldId, entityType, displayId: `${name}-${crypto.randomUUID()}`, name, createdBy },
    { actorEntityId: createdBy },
  ));
}

async function command(actor, actionType, key, payload, execute) {
  return runCommand(pool, {
    worldId: actor.world_id,
    actorEntityId: actor.entity_id,
    actionType,
    idempotencyKey: key,
    payload,
  }, execute);
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('unilateral declarations stay unilateral and derived facts retain authoritative source provenance', async () => {
  const system = await entity('world-a', 'SYSTEM', 'system');
  const alice = await entity('world-a', 'HUMAN', 'alice', system.entity_id);
  const bob = await entity('world-a', 'HUMAN', 'bob', system.entity_id);

  const unilateral = await command(
    alice,
    'social.relationship.record_unilateral',
    'alice-considers-bob',
    { subject: alice.entity_id, object: bob.entity_id, relationshipType: 'considers_friend' },
    (client, ctx) => recordRelationship(client, {
      worldId: 'world-a',
      subjectEntityId: alice.entity_id,
      objectEntityId: bob.entity_id,
      relationshipType: 'considers_friend',
      mode: 'UNILATERAL',
      validFrom: '2026-01-01T00:00:00Z',
    }, ctx),
  );
  assert.equal(unilateral.result.mode, 'UNILATERAL');
  assert.equal(unilateral.result.version.provenance.source_kind, 'ENTITY_DECLARATION');
  assert.equal(unilateral.result.version.provenance.records[0].record_id, unilateral.actionId);
  assert.equal(unilateral.result.version.provenance.records[0].participant_role, 'SUBJECT');

  const unilateralHistory = await withTransaction(pool, (client) => getRelationshipHistory(client, {
    worldId: 'world-a',
    relationshipId: unilateral.result.relationshipId,
  }));
  const unilateralContract = toRelationshipContract(unilateralHistory);
  assert.equal(validateRelationship(unilateralContract), true, JSON.stringify(validateRelationship.errors));

  await assert.rejects(
    () => command(
      bob,
      'social.relationship.record_unilateral',
      'bob-forges-alice',
      { subject: alice.entity_id, object: bob.entity_id, relationshipType: 'considers_friend' },
      (client, ctx) => recordRelationship(client, {
        worldId: 'world-a',
        subjectEntityId: alice.entity_id,
        objectEntityId: bob.entity_id,
        relationshipType: 'considers_friend',
        mode: 'UNILATERAL',
        validFrom: '2026-01-01T00:00:00Z',
      }, ctx),
    ),
    (error) => error.code === 'UNILATERAL_ACTOR_MISMATCH',
  );

  await assert.rejects(
    () => command(
      system,
      'social.relationship.invalid_mode_probe',
      'worked-with-unilateral',
      { subject: alice.entity_id, object: bob.entity_id },
      (client, ctx) => recordRelationship(client, {
        worldId: 'world-a',
        subjectEntityId: alice.entity_id,
        objectEntityId: bob.entity_id,
        relationshipType: 'worked_with',
        mode: 'UNILATERAL',
        validFrom: '2026-02-01T00:00:00Z',
        sourceRef: { kind: 'CONTRACT', id: 'contract-42', occurredAt: '2026-02-01T00:00:00Z' },
      }, ctx),
    ),
    (error) => error.code === 'RELATIONSHIP_MODE_MISMATCH',
  );

  await assert.rejects(
    () => command(
      system,
      'social.relationship.invalid_source_probe',
      'worked-with-self-declaration',
      { subject: alice.entity_id, object: bob.entity_id },
      (client, ctx) => recordRelationship(client, {
        worldId: 'world-a',
        subjectEntityId: alice.entity_id,
        objectEntityId: bob.entity_id,
        relationshipType: 'worked_with',
        mode: 'DERIVED',
        validFrom: '2026-02-01T00:00:00Z',
        sourceRef: { kind: 'ENTITY_DECLARATION', id: 'claim-1', occurredAt: '2026-02-01T00:00:00Z' },
      }, ctx),
    ),
    (error) => error.code === 'INVALID_SOURCE_REF',
  );

  const derived = await command(
    system,
    'social.relationship.record_derived',
    'derived-contract',
    { subject: alice.entity_id, object: bob.entity_id, relationshipType: 'worked_with' },
    (client, ctx) => recordRelationship(client, {
      worldId: 'world-a',
      subjectEntityId: alice.entity_id,
      objectEntityId: bob.entity_id,
      relationshipType: 'worked_with',
      mode: 'DERIVED',
      validFrom: '2026-02-01T00:00:00Z',
      validUntil: '2026-03-01T00:00:00Z',
      sourceRef: { kind: 'CONTRACT', id: 'contract-42', version: 3, occurredAt: '2026-02-01T00:00:00Z' },
    }, ctx),
  );
  const history = await withTransaction(pool, (client) => getRelationshipHistory(client, {
    worldId: 'world-a',
    relationshipId: derived.result.relationshipId,
  }));
  assert.deepEqual(history.versions[0].provenance, {
    source_kind: 'CONTRACT',
    records: [{
      record_type: 'CONTRACT',
      record_id: 'contract-42',
      record_version: 3,
      occurred_at: '2026-02-01T00:00:00.000Z',
    }],
  });
  assert.equal(validateRelationship(toRelationshipContract(history)), true, JSON.stringify(validateRelationship.errors));
});

test('one party cannot forge a mutual relationship; the counterparty must confirm with its own action', async () => {
  const system = await entity('world-a', 'SYSTEM', 'system');
  const alice = await entity('world-a', 'HUMAN', 'alice', system.entity_id);
  const bob = await entity('world-a', 'HUMAN', 'bob', system.entity_id);

  const proposed = await command(
    alice,
    'social.relationship.propose_mutual',
    'mutual-proposal',
    { subject: alice.entity_id, object: bob.entity_id, relationshipType: 'mutual_friendship' },
    (client, ctx) => proposeMutualRelationship(client, {
      worldId: 'world-a',
      subjectEntityId: alice.entity_id,
      objectEntityId: bob.entity_id,
      relationshipType: 'mutual_friendship',
      validFrom: '2026-04-01T00:00:00Z',
    }, ctx),
  );

  assert.equal((await pool.query('SELECT count(*)::int n FROM social.relationships')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM social.relationship_versions')).rows[0].n, 0);

  await assert.rejects(
    () => command(
      alice,
      'social.relationship.confirm_mutual',
      'self-confirm',
      { proposalId: proposed.result.proposal_id },
      (client, ctx) => confirmMutualRelationship(client, {
        worldId: 'world-a',
        proposalId: proposed.result.proposal_id,
      }, ctx),
    ),
    (error) => error.code === 'MUTUAL_SECOND_PARTY_REQUIRED',
  );
  assert.equal((await pool.query('SELECT count(*)::int n FROM social.relationship_versions')).rows[0].n, 0);

  const confirmed = await command(
    bob,
    'social.relationship.confirm_mutual',
    'bob-confirms',
    { proposalId: proposed.result.proposal_id },
    (client, ctx) => confirmMutualRelationship(client, {
      worldId: 'world-a',
      proposalId: proposed.result.proposal_id,
    }, ctx),
  );
  assert.equal(confirmed.result.mode, 'MUTUAL');
  assert.equal(confirmed.result.version.version, 1);
  assert.equal(confirmed.result.version.provenance.source_kind, 'MUTUAL_CONFIRMATION');
  assert.deepEqual(
    new Set(confirmed.result.version.provenance.records.map((record) => record.record_id)),
    new Set([proposed.actionId, confirmed.actionId]),
  );
  assert.deepEqual(
    new Set(confirmed.result.version.provenance.records.map((record) => record.participant_role)),
    new Set(['SUBJECT', 'OBJECT']),
  );

  const history = await withTransaction(pool, (client) => getRelationshipHistory(client, {
    worldId: 'world-a',
    relationshipId: confirmed.result.relationshipId,
  }));
  assert.equal(validateRelationship(toRelationshipContract(history)), true, JSON.stringify(validateRelationship.errors));
});

test('database constraints reject a mutual fact with no two-party evidence', async () => {
  const system = await entity('world-a', 'SYSTEM', 'system');
  const alice = await entity('world-a', 'HUMAN', 'alice', system.entity_id);
  const bob = await entity('world-a', 'HUMAN', 'bob', system.entity_id);
  const evidence = await command(
    system,
    'social.relationship.database_probe',
    'mutual-forgery-evidence',
    { purpose: 'constraint-test' },
    async () => ({ ok: true }),
  );
  const evidenceRow = (await pool.query('SELECT created_at FROM core.actions WHERE action_id=$1', [evidence.actionId])).rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [subject, object] = String(alice.entity_id) < String(bob.entity_id)
      ? [alice.entity_id, bob.entity_id]
      : [bob.entity_id, alice.entity_id];
    const relationshipId = crypto.randomUUID();
    await client.query(
      `INSERT INTO social.relationships
        (relationship_id,world_id,subject_entity_id,object_entity_id,relationship_type,relationship_mode)
       VALUES ($1,'world-a',$2,$3,'mutual_friendship','MUTUAL')`,
      [relationshipId, subject, object],
    );
    await client.query(
      `INSERT INTO social.relationship_versions
        (relationship_id,version,world_id,status,dispute_status,changed_at,valid_from,provenance,recorded_by_entity_id,recorded_action_id)
       VALUES ($1,1,'world-a','ACTIVE','NONE',$2,'2026-04-01T00:00:00Z',$3::jsonb,$4,$5)`,
      [
        relationshipId,
        evidenceRow.created_at,
        JSON.stringify({
          source_kind: 'MUTUAL_CONFIRMATION',
          records: [
            { record_type: 'CONFIRMATION', record_id: 'fake-subject', participant_role: 'SUBJECT', occurred_at: '2026-04-01T00:00:00Z' },
            { record_type: 'CONFIRMATION', record_id: 'fake-object', participant_role: 'OBJECT', occurred_at: '2026-04-01T00:00:00Z' },
          ],
        }),
        system.entity_id,
        evidence.actionId,
      ],
    );
    await assert.rejects(
      () => client.query('COMMIT'),
      (error) => error.code === '23514',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM social.relationships')).rows[0].n, 0);
});

test('relationship revisions are append-only and preserve prior state, dispute, validity, and provenance', async () => {
  const system = await entity('world-a', 'SYSTEM', 'system');
  const alice = await entity('world-a', 'HUMAN', 'alice', system.entity_id);
  const bob = await entity('world-a', 'HUMAN', 'bob', system.entity_id);

  const created = await command(
    alice,
    'social.relationship.record_unilateral',
    'history-v1',
    { relationshipType: 'considers_friend', revision: 1 },
    (client, ctx) => recordRelationship(client, {
      worldId: 'world-a',
      subjectEntityId: alice.entity_id,
      objectEntityId: bob.entity_id,
      relationshipType: 'considers_friend',
      mode: 'UNILATERAL',
      status: 'ACTIVE',
      disputeStatus: 'NONE',
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-12-31T00:00:00Z',
    }, ctx),
  );
  const relationshipId = created.result.relationshipId;

  const ended = await command(
    alice,
    'social.relationship.append_unilateral',
    'history-v2',
    { relationshipId, revision: 2 },
    (client, ctx) => appendRelationshipVersion(client, {
      worldId: 'world-a',
      relationshipId,
      status: 'ENDED',
      disputeStatus: 'RESOLVED',
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-06-01T00:00:00Z',
    }, ctx),
  );

  const history = await withTransaction(pool, (client) => getRelationshipHistory(client, { worldId: 'world-a', relationshipId }));
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].version, 1);
  assert.equal(history.versions[0].status, 'ACTIVE');
  assert.equal(history.versions[0].dispute_status, 'NONE');
  assert.equal(history.versions[0].valid_until.toISOString(), '2026-12-31T00:00:00.000Z');
  assert.equal(history.versions[0].provenance.records[0].record_id, created.actionId);
  assert.equal(history.versions[1].version, 2);
  assert.equal(history.versions[1].status, 'ENDED');
  assert.equal(history.versions[1].dispute_status, 'RESOLVED');
  assert.equal(history.versions[1].valid_until.toISOString(), '2026-06-01T00:00:00.000Z');
  assert.equal(history.versions[1].provenance.records[0].record_id, ended.actionId);
  assert.equal(validateRelationship(toRelationshipContract(history)), true, JSON.stringify(validateRelationship.errors));

  await assert.rejects(
    () => pool.query(
      `UPDATE social.relationship_versions SET provenance=$1::jsonb WHERE relationship_id=$2 AND version=1`,
      [JSON.stringify({ source_kind: 'ENTITY_DECLARATION', records: [] }), relationshipId],
    ),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    () => pool.query('DELETE FROM social.relationship_versions WHERE relationship_id=$1 AND version=1', [relationshipId]),
    (error) => error.code === '55000',
  );
});

test('current relationship view keeps the latest started fact and does not let future revisions hide it', async () => {
  const system = await entity('world-a', 'SYSTEM', 'system');
  const alice = await entity('world-a', 'HUMAN', 'alice', system.entity_id);
  const bob = await entity('world-a', 'HUMAN', 'bob', system.entity_id);

  const created = await command(
    alice,
    'social.relationship.record_unilateral',
    'effective-v1',
    { relationshipType: 'considers_friend', revision: 1 },
    (client, ctx) => recordRelationship(client, {
      worldId: 'world-a',
      subjectEntityId: alice.entity_id,
      objectEntityId: bob.entity_id,
      relationshipType: 'considers_friend',
      mode: 'UNILATERAL',
      validFrom: '2020-01-01T00:00:00Z',
    }, ctx),
  );
  const relationshipId = created.result.relationshipId;

  await command(
    alice,
    'social.relationship.append_unilateral',
    'effective-v2-future',
    { relationshipId, revision: 2 },
    (client, ctx) => appendRelationshipVersion(client, {
      worldId: 'world-a',
      relationshipId,
      status: 'ACTIVE',
      disputeStatus: 'OPEN',
      validFrom: '2999-01-01T00:00:00Z',
    }, ctx),
  );

  const current = await pool.query(
    `SELECT version, dispute_status, provenance
       FROM social.current_relationships
      WHERE world_id=$1 AND relationship_id=$2`,
    ['world-a', relationshipId],
  );
  assert.equal(current.rowCount, 1);
  assert.equal(current.rows[0].version, 1);
  assert.equal(current.rows[0].dispute_status, 'NONE');
  assert.equal(current.rows[0].provenance.records[0].record_id, created.actionId);
});

test('an ended latest version cannot resurrect an older active version in the current view', async () => {
  const system = await entity('world-a', 'SYSTEM', 'system');
  const alice = await entity('world-a', 'HUMAN', 'alice', system.entity_id);
  const bob = await entity('world-a', 'HUMAN', 'bob', system.entity_id);

  const created = await command(
    alice,
    'social.relationship.record_unilateral',
    'ended-current-v1',
    { relationshipType: 'considers_friend', revision: 1 },
    (client, ctx) => recordRelationship(client, {
      worldId: 'world-a',
      subjectEntityId: alice.entity_id,
      objectEntityId: bob.entity_id,
      relationshipType: 'considers_friend',
      mode: 'UNILATERAL',
      validFrom: '2020-01-01T00:00:00Z',
    }, ctx),
  );

  await command(
    alice,
    'social.relationship.append_unilateral',
    'ended-current-v2',
    { relationshipId: created.result.relationshipId, revision: 2 },
    (client, ctx) => appendRelationshipVersion(client, {
      worldId: 'world-a',
      relationshipId: created.result.relationshipId,
      status: 'ENDED',
      disputeStatus: 'RESOLVED',
      validFrom: '2020-01-01T00:00:00Z',
      validUntil: '2026-09-01T00:00:00Z',
    }, ctx),
  );

  const current = await pool.query(
    `SELECT relationship_id FROM social.current_relationships WHERE world_id=$1 AND relationship_id=$2`,
    ['world-a', created.result.relationshipId],
  );
  assert.equal(current.rowCount, 0);
});
