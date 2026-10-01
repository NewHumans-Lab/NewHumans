import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/db.js';

const pool = createPool();
const world = 'm04-organization-data-test';
let system;
let organizationEntity;
let member;

async function resetOrganizationData() {
  await pool.query(`TRUNCATE
    social.organization_role_history,
    social.organization_roles,
    social.memberships,
    social.organization_revisions,
    social.organizations
    RESTART IDENTITY`);
  await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE');
}

async function createEntity(entityType, displayId) {
  const result = await pool.query(
    `INSERT INTO core.entities (world_id,entity_type,display_id,name)
     VALUES ($1,$2,$3,$3)
     RETURNING entity_id,entity_type`,
    [world, entityType, displayId],
  );
  return result.rows[0];
}

async function createOrganization({ charterRef = 'kb://charters/acme/v1', kbAccountRef = 'kb://accounts/acme' } = {}) {
  const result = await pool.query(
    `INSERT INTO social.organizations
      (world_id,organization_entity_id,metadata,charter_ref,kb_account_ref,created_by,updated_by)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$6)
     RETURNING *`,
    [world, organizationEntity.entity_id, JSON.stringify({ name: 'Acme', purpose: 'test' }), charterRef, kbAccountRef, system.entity_id],
  );
  return result.rows[0];
}

async function joinMember(memberEntityId = member.entity_id) {
  const result = await pool.query(
    `INSERT INTO social.memberships
      (world_id,organization_entity_id,member_entity_id,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$4)
     RETURNING *`,
    [world, organizationEntity.entity_id, memberEntityId, system.entity_id],
  );
  return result.rows[0];
}

async function grantRole(membershipId, roleKey = 'MEMBER') {
  const result = await pool.query(
    `INSERT INTO social.organization_roles
      (world_id,organization_entity_id,membership_id,role_key,role_metadata,granted_by,updated_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
     RETURNING *`,
    [world, organizationEntity.entity_id, membershipId, roleKey, JSON.stringify({ label: 'Member' }), system.entity_id],
  );
  return result.rows[0];
}

test.beforeEach(async () => {
  await resetOrganizationData();
  system = await createEntity('SYSTEM', 'system');
  organizationEntity = await createEntity('ORGANIZATION', 'acme');
  member = await createEntity('HUMAN', 'member');
});

test.after(async () => {
  await resetOrganizationData();
  await pool.end();
});

test('organization metadata is anchored to an M01 organization Entity and versions charter/account refs', async () => {
  const organization = await createOrganization();
  assert.equal(String(organization.version), '1');
  assert.equal(organization.charter_ref, 'kb://charters/acme/v1');
  assert.equal(organization.kb_account_ref, 'kb://accounts/acme');

  const updated = await pool.query(
    `UPDATE social.organizations
        SET metadata=$3::jsonb,
            charter_ref=$4,
            version=version+1,
            updated_by=$5
      WHERE world_id=$1 AND organization_entity_id=$2
      RETURNING version,charter_ref,metadata`,
    [world, organizationEntity.entity_id, JSON.stringify({ name: 'Acme', purpose: 'revised' }), 'kb://charters/acme/v2', system.entity_id],
  );
  assert.equal(String(updated.rows[0].version), '2');
  assert.equal(updated.rows[0].charter_ref, 'kb://charters/acme/v2');
  assert.equal(updated.rows[0].metadata.purpose, 'revised');

  const revisions = await pool.query(
    `SELECT version,charter_ref,kb_account_ref
       FROM social.organization_revisions
      WHERE world_id=$1 AND organization_entity_id=$2
      ORDER BY version`,
    [world, organizationEntity.entity_id],
  );
  assert.deepEqual(revisions.rows.map((row) => String(row.version)), ['1', '2']);
  assert.deepEqual(revisions.rows.map((row) => row.charter_ref), ['kb://charters/acme/v1', 'kb://charters/acme/v2']);

  await assert.rejects(
    () => pool.query(
      `UPDATE social.organizations
          SET version=version+2, updated_by=$3
        WHERE world_id=$1 AND organization_entity_id=$2`,
      [world, organizationEntity.entity_id, system.entity_id],
    ),
    /organization version must advance exactly once/,
  );
  await assert.rejects(
    () => pool.query(
      `UPDATE social.organization_revisions
          SET charter_ref='kb://tampered'
        WHERE world_id=$1 AND organization_entity_id=$2 AND version=1`,
      [world, organizationEntity.entity_id],
    ),
    /append-only organization evidence/,
  );

  const humanOrganization = await createEntity('HUMAN', 'not-an-organization');
  await assert.rejects(
    () => pool.query(
      `INSERT INTO social.organizations
        (world_id,organization_entity_id,metadata,created_by,updated_by)
       VALUES ($1,$2,'{}'::jsonb,$3,$3)`,
      [world, humanOrganization.entity_id, system.entity_id],
    ),
    /must reference an M01 COMPANY or ORGANIZATION Entity/,
  );

  await assert.rejects(
    () => pool.query(
      `UPDATE core.entities SET entity_type='HUMAN'
        WHERE world_id=$1 AND entity_id=$2`,
      [world, organizationEntity.entity_id],
    ),
    /organization Entity type cannot change while M04 organization data references it/,
  );
});

test('membership uniqueness applies only while active and exit preserves history while allowing rejoin', async () => {
  await createOrganization();

  await assert.rejects(
    () => joinMember(randomUUID()),
    (error) => error.code === '23503',
  );

  const first = await joinMember();
  await assert.rejects(
    () => pool.query(
      'DELETE FROM core.entities WHERE world_id=$1 AND entity_id=$2',
      [world, member.entity_id],
    ),
    (error) => error.code === '23503' && /referenced by M04 organization data/.test(error.message),
  );

  await assert.rejects(
    () => joinMember(),
    (error) => error.constraint === 'memberships_one_active_member_idx',
  );

  const exited = await pool.query(
    `UPDATE social.memberships
        SET left_at=now(), leave_reason='voluntary exit', version=version+1, updated_by=$3
      WHERE world_id=$1 AND membership_id=$2
      RETURNING version,left_at,leave_reason`,
    [world, first.membership_id, system.entity_id],
  );
  assert.equal(String(exited.rows[0].version), '2');
  assert.ok(exited.rows[0].left_at);
  assert.equal(exited.rows[0].leave_reason, 'voluntary exit');

  const second = await joinMember();
  assert.notEqual(second.membership_id, first.membership_id);

  const history = await pool.query(
    `SELECT membership_id,left_at
       FROM social.memberships
      WHERE world_id=$1 AND organization_entity_id=$2 AND member_entity_id=$3
      ORDER BY joined_at,membership_id`,
    [world, organizationEntity.entity_id, member.entity_id],
  );
  assert.equal(history.rowCount, 2);
  assert.equal(history.rows.filter((row) => row.left_at === null).length, 1);

  await assert.rejects(
    () => pool.query(
      `UPDATE social.memberships
          SET leave_reason='rewrite', version=version+1, updated_by=$3
        WHERE world_id=$1 AND membership_id=$2`,
      [world, first.membership_id, system.entity_id],
    ),
    /exited membership is immutable/,
  );
});

test('role changes are versioned into append-only history and membership exit revokes current roles', async () => {
  await createOrganization();
  const membership = await joinMember();
  const role = await grantRole(membership.membership_id);

  await pool.query(
    `UPDATE social.organization_roles
        SET role_metadata=$3::jsonb, version=version+1, updated_by=$4
      WHERE world_id=$1 AND role_assignment_id=$2`,
    [world, role.role_assignment_id, JSON.stringify({ label: 'Senior Member' }), system.entity_id],
  );

  await pool.query(
    `UPDATE social.memberships
        SET left_at=now(), leave_reason='left organization', version=version+1, updated_by=$3
      WHERE world_id=$1 AND membership_id=$2`,
    [world, membership.membership_id, system.entity_id],
  );

  const currentRole = await pool.query(
    `SELECT version,revoked_at,revoked_by,role_metadata
       FROM social.organization_roles
      WHERE world_id=$1 AND role_assignment_id=$2`,
    [world, role.role_assignment_id],
  );
  assert.equal(String(currentRole.rows[0].version), '3');
  assert.ok(currentRole.rows[0].revoked_at);
  assert.equal(currentRole.rows[0].revoked_by, system.entity_id);
  assert.equal(currentRole.rows[0].role_metadata.label, 'Senior Member');

  const roleHistory = await pool.query(
    `SELECT version,status,role_metadata
       FROM social.organization_role_history
      WHERE world_id=$1 AND role_assignment_id=$2
      ORDER BY version`,
    [world, role.role_assignment_id],
  );
  assert.deepEqual(roleHistory.rows.map((row) => String(row.version)), ['1', '2', '3']);
  assert.deepEqual(roleHistory.rows.map((row) => row.status), ['GRANTED', 'UPDATED', 'REVOKED']);
  assert.equal(roleHistory.rows[1].role_metadata.label, 'Senior Member');

  await assert.rejects(
    () => pool.query(
      `UPDATE social.organization_roles
          SET role_metadata='{"label":"illegal"}'::jsonb, version=version+1, updated_by=$3
        WHERE world_id=$1 AND role_assignment_id=$2`,
      [world, role.role_assignment_id, system.entity_id],
    ),
    /revoked role assignment is immutable/,
  );
  await assert.rejects(
    () => pool.query(
      `DELETE FROM social.organization_role_history
        WHERE world_id=$1 AND role_assignment_id=$2 AND version=1`,
      [world, role.role_assignment_id],
    ),
    /append-only organization evidence/,
  );
});

test('M04 stores only the opaque KB account reference and creates no organization wallet authority', async () => {
  const before = await pool.query(
    `SELECT count(*)::int AS count FROM economy.wallets
      WHERE world_id=$1 AND entity_id=$2`,
    [world, organizationEntity.entity_id],
  );
  assert.equal(before.rows[0].count, 0);

  await createOrganization({ kbAccountRef: 'kb://accounts/acme-authority' });

  const after = await pool.query(
    `SELECT count(*)::int AS count FROM economy.wallets
      WHERE world_id=$1 AND entity_id=$2`,
    [world, organizationEntity.entity_id],
  );
  assert.equal(after.rows[0].count, 0);

  const stored = await pool.query(
    `SELECT kb_account_ref FROM social.organizations
      WHERE world_id=$1 AND organization_entity_id=$2`,
    [world, organizationEntity.entity_id],
  );
  assert.equal(stored.rows[0].kb_account_ref, 'kb://accounts/acme-authority');

  const socialWalletTables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='social' AND table_name ILIKE '%wallet%'`,
  );
  assert.deepEqual(socialWalletTables.rows, []);

  const organizationColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='social' AND table_name='organizations'`,
  );
  const columns = new Set(organizationColumns.rows.map((row) => row.column_name));
  assert.ok(columns.has('kb_account_ref'));
  for (const forbidden of ['posted_balance_micro_e', 'available_micro_e', 'frozen_micro_e', 'reserved_micro_e', 'wallet_id']) {
    assert.equal(columns.has(forbidden), false, `${forbidden} must not be owned by M04 organizations`);
  }
});
