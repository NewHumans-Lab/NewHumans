import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../../src/db.js';

const pool = createPool();

async function reset() {
  await pool.query('TRUNCATE core.entities RESTART IDENTITY CASCADE');
}

async function entity(worldId, entityType, name) {
  return (await pool.query(
    `INSERT INTO core.entities (world_id, entity_type, display_id, name)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [worldId, entityType, `${name}-${crypto.randomUUID()}`, name],
  )).rows[0];
}

async function contractFixture(worldId = 'm04-contract-world') {
  const employer = await entity(worldId, 'HUMAN', 'employer');
  const contractor = await entity(worldId, 'AGENT', 'contractor');
  const contract = (await pool.query(
    `INSERT INTO social.contracts (world_id, employer_entity_id, contractor_entity_id)
     VALUES ($1,$2,$3) RETURNING *`,
    [worldId, employer.entity_id, contractor.entity_id],
  )).rows[0];
  return { worldId, employer, contractor, contract };
}

async function addVersion({ worldId, contract, author, version, parentVersion = null, acceptanceCriteria = { checks: ['artifact-reviewed'] } }) {
  return (await pool.query(
    `INSERT INTO social.contract_versions (
       world_id, contract_id, version, parent_version, scope, deliverables,
       acceptance_criteria, price_micro_e, rule_version, author_entity_id
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
     RETURNING *`,
    [
      worldId,
      contract.contract_id,
      version,
      parentVersion,
      `scope-v${version}`,
      JSON.stringify([{ artifact: `artifact-v${version}` }]),
      JSON.stringify(acceptanceCriteria),
      '1000000',
      'nh.v3.0',
      author.entity_id,
    ],
  )).rows[0];
}

async function accept({ worldId, contract, version, party, key }) {
  return (await pool.query(
    `INSERT INTO social.contract_acceptances (
       world_id, contract_id, version, party_entity_id, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [worldId, contract.contract_id, version, party.entity_id, key],
  )).rows[0];
}

test.beforeEach(reset);
test.after(async () => pool.end());

test('contract state machine rejects illegal transitions and ACTIVE requires external escrow', async () => {
  const fx = await contractFixture();
  await addVersion({ ...fx, author: fx.employer, version: 1 });
  await accept({ ...fx, version: 1, party: fx.employer, key: 'employer-v1' });
  await accept({ ...fx, version: 1, party: fx.contractor, key: 'contractor-v1' });

  await assert.rejects(
    () => pool.query(`UPDATE social.contracts SET status='SUBMITTED' WHERE contract_id=$1`, [fx.contract.contract_id]),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    () => pool.query(`UPDATE social.contracts SET status='ACTIVE' WHERE contract_id=$1`, [fx.contract.contract_id]),
    (error) => error.code === '23514',
  );

  await pool.query(
    `UPDATE social.contracts
        SET status='ACTIVE', escrow_external_ref='kb-escrow:contract-1'
      WHERE contract_id=$1`,
    [fx.contract.contract_id],
  );
  assert.equal((await pool.query('SELECT status FROM social.contracts WHERE contract_id=$1', [fx.contract.contract_id])).rows[0].status, 'ACTIVE');

  await assert.rejects(
    () => pool.query(`UPDATE social.contracts SET status='SETTLED' WHERE contract_id=$1`, [fx.contract.contract_id]),
    (error) => error.code === '23514',
  );
  await pool.query(`UPDATE social.contracts SET status='SUBMITTED' WHERE contract_id=$1`, [fx.contract.contract_id]);
  await pool.query(`UPDATE social.contracts SET status='SETTLED' WHERE contract_id=$1`, [fx.contract.contract_id]);
  assert.equal((await pool.query('SELECT status FROM social.contracts WHERE contract_id=$1', [fx.contract.contract_id])).rows[0].status, 'SETTLED');
});

test('publishing a new version invalidates old acceptances and activation requires current-version acceptance', async () => {
  const fx = await contractFixture('m04-version-world');
  await addVersion({ ...fx, author: fx.employer, version: 1 });
  await accept({ ...fx, version: 1, party: fx.employer, key: 'employer-v1' });
  await accept({ ...fx, version: 1, party: fx.contractor, key: 'contractor-v1' });

  await addVersion({ ...fx, author: fx.employer, version: 2, parentVersion: 1 });

  const oldAcceptances = (await pool.query(
    `SELECT invalidated_at FROM social.contract_acceptances
      WHERE contract_id=$1 AND version=1 ORDER BY accepted_at`,
    [fx.contract.contract_id],
  )).rows;
  assert.equal(oldAcceptances.length, 2);
  assert.ok(oldAcceptances.every((row) => row.invalidated_at));
  assert.equal((await pool.query('SELECT current_version FROM social.contracts WHERE contract_id=$1', [fx.contract.contract_id])).rows[0].current_version, 2);

  await assert.rejects(
    () => pool.query(
      `UPDATE social.contracts SET status='ACTIVE', escrow_external_ref='kb-escrow:v2' WHERE contract_id=$1`,
      [fx.contract.contract_id],
    ),
    (error) => error.code === '23514',
  );

  await accept({ ...fx, version: 2, party: fx.employer, key: 'employer-v2' });
  await assert.rejects(
    () => pool.query(
      `UPDATE social.contracts SET status='ACTIVE', escrow_external_ref='kb-escrow:v2' WHERE contract_id=$1`,
      [fx.contract.contract_id],
    ),
    (error) => error.code === '23514',
  );

  await accept({ ...fx, version: 2, party: fx.contractor, key: 'contractor-v2' });
  await pool.query(
    `UPDATE social.contracts SET status='ACTIVE', escrow_external_ref='kb-escrow:v2' WHERE contract_id=$1`,
    [fx.contract.contract_id],
  );
  assert.equal((await pool.query('SELECT status FROM social.contracts WHERE contract_id=$1', [fx.contract.contract_id])).rows[0].status, 'ACTIVE');
});

test('contract with missing acceptance criteria cannot become ACTIVE', async () => {
  const fx = await contractFixture('m04-criteria-world');
  await addVersion({ ...fx, author: fx.employer, version: 1, acceptanceCriteria: {} });
  await accept({ ...fx, version: 1, party: fx.employer, key: 'employer-empty-criteria' });
  await accept({ ...fx, version: 1, party: fx.contractor, key: 'contractor-empty-criteria' });

  await assert.rejects(
    () => pool.query(
      `UPDATE social.contracts
          SET status='ACTIVE', escrow_external_ref='kb-escrow:criteria'
        WHERE contract_id=$1`,
      [fx.contract.contract_id],
    ),
    (error) => error.code === '23514' && /acceptance criteria/.test(error.message),
  );
});

test('milestone, delivery and dispute data stay version-bound and M04 creates no escrow balance table', async () => {
  const fx = await contractFixture('m04-evidence-world');
  await addVersion({ ...fx, author: fx.employer, version: 1 });

  const milestone = (await pool.query(
    `INSERT INTO social.milestones (
       world_id, contract_id, version, ordinal, title, acceptance_criteria
     ) VALUES ($1,$2,1,1,'first milestone',$3::jsonb) RETURNING *`,
    [fx.worldId, fx.contract.contract_id, JSON.stringify({ checks: ['tests-green'] })],
  )).rows[0];

  const delivery = (await pool.query(
    `INSERT INTO social.deliveries (
       world_id, contract_id, version, milestone_id, submission_no,
       submitted_by_entity_id, artifact_ref, idempotency_key
     ) VALUES ($1,$2,1,$3,1,$4,'artifact://delivery/1','delivery-1') RETURNING *`,
    [fx.worldId, fx.contract.contract_id, milestone.milestone_id, fx.contractor.entity_id],
  )).rows[0];

  const dispute = (await pool.query(
    `INSERT INTO social.disputes (
       world_id, contract_id, version, delivery_id, raised_by_entity_id, reason, evidence
     ) VALUES ($1,$2,1,$3,$4,'acceptance evidence mismatch',$5::jsonb) RETURNING *`,
    [fx.worldId, fx.contract.contract_id, delivery.delivery_id, fx.employer.entity_id, JSON.stringify({ delivery: delivery.delivery_id })],
  )).rows[0];

  assert.equal(dispute.delivery_id, delivery.delivery_id);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='social' AND table_name ILIKE '%escrow%'`)).rows[0].n, 0);
  assert.deepEqual(
    (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='social' AND table_name='contracts' AND column_name LIKE '%escrow%'
        ORDER BY column_name`,
    )).rows.map((row) => row.column_name),
    ['escrow_external_ref'],
  );
});
