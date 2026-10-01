import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/db.js';

const pool = createPool();

async function reset() {
  await pool.query('TRUNCATE core.entities CASCADE');
}

async function entity(worldId = 'm04-world', displayId = `entity-${randomUUID()}`) {
  const result = await pool.query(
    `INSERT INTO core.entities (world_id, entity_type, display_id, name)
     VALUES ($1, 'AGENT', $2, $3)
     RETURNING *`,
    [worldId, displayId, displayId],
  );
  return result.rows[0];
}

async function insertEvidence(owner, overrides = {}) {
  const values = {
    evidenceKey: 'portfolio-primary',
    version: 1,
    evidenceType: 'WORK_PRODUCT',
    capabilityKey: 'software.postgresql',
    sourceRef: 'artifact://portfolio-primary',
    ...overrides,
  };
  return pool.query(
    `INSERT INTO social.ability_evidence
       (world_id, entity_id, evidence_key, version, evidence_type, capability_key, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [owner.world_id, owner.entity_id, values.evidenceKey, values.version,
      values.evidenceType, values.capabilityKey, values.sourceRef],
  );
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('empty-database migration installs the M04 directory schema', async () => {
  const migration = await pool.query(
    "SELECT 1 FROM meta.schema_migrations WHERE name='0500_m04_directory_data.sql'",
  );
  assert.equal(migration.rowCount, 1);
  const tables = await pool.query(
    `SELECT to_regclass('social.directory_profiles')::text AS profiles,
            to_regclass('social.contact_preferences')::text AS contacts,
            to_regclass('social.ability_evidence')::text AS evidence`,
  );
  assert.equal(tables.rows[0].profiles, 'social.directory_profiles');
  assert.equal(tables.rows[0].contacts, 'social.contact_preferences');
  assert.equal(tables.rows[0].evidence, 'social.ability_evidence');
});

test('all M04 directory foreign keys target only the existing Entity authority', async () => {
  const fks = await pool.query(
    `SELECT c.conname, c.confrelid::regclass::text AS target
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname='social' AND c.contype='f'
      ORDER BY c.conname`,
  );
  assert.equal(fks.rowCount, 3);
  assert.deepEqual(new Set(fks.rows.map((row) => row.target)), new Set(['core.entities']));

  const ghost = randomUUID();
  await assert.rejects(
    () => pool.query(
      `INSERT INTO social.directory_profiles (world_id, entity_id, headline)
       VALUES ('m04-world',$1,'ghost')`,
      [ghost],
    ),
    (error) => error.code === '23503',
  );

  const owner = await entity('world-a');
  await assert.rejects(
    () => pool.query(
      `INSERT INTO social.contact_preferences (world_id, entity_id)
       VALUES ('world-b',$1)`,
      [owner.entity_id],
    ),
    (error) => error.code === '23503',
  );
});

test('profile and contact preference rows are unique per world Entity', async () => {
  const owner = await entity();
  await pool.query(
    `INSERT INTO social.directory_profiles (world_id, entity_id, headline)
     VALUES ($1,$2,'Builder')`,
    [owner.world_id, owner.entity_id],
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO social.directory_profiles (world_id, entity_id, headline)
       VALUES ($1,$2,'Duplicate')`,
      [owner.world_id, owner.entity_id],
    ),
    (error) => error.code === '23505',
  );

  await pool.query(
    `INSERT INTO social.contact_preferences (world_id, entity_id)
     VALUES ($1,$2)`,
    [owner.world_id, owner.entity_id],
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO social.contact_preferences (world_id, entity_id)
       VALUES ($1,$2)`,
      [owner.world_id, owner.entity_id],
    ),
    (error) => error.code === '23505',
  );
});

test('profile and contact preference versions advance exactly one step', async () => {
  const owner = await entity();
  await pool.query(
    `INSERT INTO social.directory_profiles (world_id, entity_id, headline)
     VALUES ($1,$2,'v1')`,
    [owner.world_id, owner.entity_id],
  );
  await assert.rejects(
    () => pool.query(
      `UPDATE social.directory_profiles SET headline='bad', version=3
       WHERE world_id=$1 AND entity_id=$2`,
      [owner.world_id, owner.entity_id],
    ),
    (error) => error.code === '23514',
  );
  const profile = await pool.query(
    `UPDATE social.directory_profiles SET headline='v2', version=2
     WHERE world_id=$1 AND entity_id=$2 RETURNING version, headline`,
    [owner.world_id, owner.entity_id],
  );
  assert.deepEqual(profile.rows[0], { version: 2, headline: 'v2' });

  await pool.query(
    `INSERT INTO social.contact_preferences (world_id, entity_id)
     VALUES ($1,$2)`,
    [owner.world_id, owner.entity_id],
  );
  await assert.rejects(
    () => pool.query(
      `UPDATE social.contact_preferences SET allow_unknown_senders=false, version=1
       WHERE world_id=$1 AND entity_id=$2`,
      [owner.world_id, owner.entity_id],
    ),
    (error) => error.code === '23514',
  );
  const contact = await pool.query(
    `UPDATE social.contact_preferences SET allow_unknown_senders=false, version=2
     WHERE world_id=$1 AND entity_id=$2 RETURNING version, allow_unknown_senders`,
    [owner.world_id, owner.entity_id],
  );
  assert.deepEqual(contact.rows[0], { version: 2, allow_unknown_senders: false });
});

test('ability evidence rejects duplicate logical versions and accepts the next version', async () => {
  const owner = await entity();
  await insertEvidence(owner);
  await assert.rejects(
    () => insertEvidence(owner),
    (error) => error.code === '23505',
  );
  await insertEvidence(owner, { version: 2, sourceRef: 'artifact://portfolio-primary-v2' });
  const rows = await pool.query(
    `SELECT version FROM social.ability_evidence
      WHERE world_id=$1 AND entity_id=$2 AND evidence_key='portfolio-primary'
      ORDER BY version`,
    [owner.world_id, owner.entity_id],
  );
  assert.deepEqual(rows.rows.map((row) => row.version), [1, 2]);
  await assert.rejects(
    () => insertEvidence(owner, { evidenceKey: 'bad-version', version: 0 }),
    (error) => error.code === '23514',
  );
});

test('directory rows can be deleted without deleting Entity, and Entity deletion is restricted while referenced', async () => {
  const owner = await entity();
  await pool.query(
    `INSERT INTO social.directory_profiles (world_id, entity_id) VALUES ($1,$2)`,
    [owner.world_id, owner.entity_id],
  );
  await pool.query(
    `INSERT INTO social.contact_preferences (world_id, entity_id) VALUES ($1,$2)`,
    [owner.world_id, owner.entity_id],
  );
  await insertEvidence(owner);

  await assert.rejects(
    () => pool.query('DELETE FROM core.entities WHERE entity_id=$1', [owner.entity_id]),
    (error) => error.code === '23503',
  );

  await pool.query('DELETE FROM social.ability_evidence WHERE entity_id=$1', [owner.entity_id]);
  await pool.query('DELETE FROM social.contact_preferences WHERE entity_id=$1', [owner.entity_id]);
  await pool.query('DELETE FROM social.directory_profiles WHERE entity_id=$1', [owner.entity_id]);
  assert.equal((await pool.query('SELECT 1 FROM core.entities WHERE entity_id=$1', [owner.entity_id])).rowCount, 1);

  await pool.query('DELETE FROM core.entities WHERE entity_id=$1', [owner.entity_id]);
  assert.equal((await pool.query('SELECT 1 FROM core.entities WHERE entity_id=$1', [owner.entity_id])).rowCount, 0);
});

test('directory schema stores no balance or lifecycle authority', async () => {
  const columns = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='social'
        AND table_name IN ('directory_profiles','contact_preferences','ability_evidence')`,
  );
  const names = new Set(columns.rows.map((row) => row.column_name));
  for (const forbidden of [
    'posted_balance_micro_e', 'available_micro_e', 'frozen_micro_e',
    'lifecycle_state', 'identity_status', 'runtime_state',
  ]) {
    assert.equal(names.has(forbidden), false, `forbidden authority column present: ${forbidden}`);
  }
});
