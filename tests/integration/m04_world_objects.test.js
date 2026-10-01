import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../../src/db.js';

const pool = createPool();
let worldSeq = 0;

function nextWorld(label) {
  worldSeq += 1;
  return `nh024-${process.pid}-${worldSeq}-${label}`;
}

async function createActors(worldId) {
  const system = (await pool.query(
    `INSERT INTO core.entities(world_id, entity_type, display_id, name)
     VALUES ($1, 'SYSTEM', $2, 'NH024 test system')
     RETURNING entity_id`,
    [worldId, `system-${crypto.randomUUID()}`]
  )).rows[0];
  const creator = (await pool.query(
    `INSERT INTO core.entities(world_id, entity_type, display_id, name, created_by)
     VALUES ($1, 'HUMAN', $2, 'Creator', $3)
     RETURNING entity_id`,
    [worldId, `creator-${crypto.randomUUID()}`, system.entity_id]
  )).rows[0];
  const contributor = (await pool.query(
    `INSERT INTO core.entities(world_id, entity_type, display_id, name, created_by)
     VALUES ($1, 'AGENT', $2, 'Contributor', $3)
     RETURNING entity_id`,
    [worldId, `contributor-${crypto.randomUUID()}`, system.entity_id]
  )).rows[0];
  return { system, creator, contributor };
}

async function createObject(worldId, creatorEntityId) {
  return (await pool.query(
    `INSERT INTO social.world_objects(
       world_id, object_type, creator_entity_id, controller_entity_id, executable_actions
     ) VALUES ($1, 'document', $2, $2, ARRAY['READ','PUBLISH_VERSION']::text[])
     RETURNING *`,
    [worldId, creatorEntityId]
  )).rows[0];
}

async function publish({
  worldId,
  objectId,
  expectedVersion,
  contentRef,
  digest,
  authorEntityId,
  changeSummary = null,
  contributors = [],
  licenses = []
}) {
  return (await pool.query(
    `SELECT * FROM social.publish_object_version(
       $1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8::jsonb, $9::jsonb
     )`,
    [
      worldId,
      objectId,
      expectedVersion,
      contentRef,
      digest,
      authorEntityId,
      changeSummary,
      JSON.stringify(contributors),
      JSON.stringify(licenses)
    ]
  )).rows[0];
}

test.after(async () => pool.end());

test('expected_version rejects stale edits and preserves every accepted version', async () => {
  const worldId = nextWorld('expected');
  const { creator } = await createActors(worldId);
  const object = await createObject(worldId, creator.entity_id);

  const v1 = await publish({
    worldId,
    objectId: object.object_id,
    expectedVersion: 0,
    contentRef: 'artifact://draft-v1',
    digest: 'a'.repeat(64),
    authorEntityId: creator.entity_id,
    changeSummary: 'initial draft'
  });
  assert.equal(v1.version, '1');
  assert.equal(v1.expected_version, '0');
  assert.equal(v1.parent_version, null);

  const head1 = (await pool.query(
    'SELECT current_version FROM social.world_objects WHERE world_id=$1 AND object_id=$2',
    [worldId, object.object_id]
  )).rows[0];
  assert.equal(head1.current_version, '1');

  await assert.rejects(
    () => publish({
      worldId,
      objectId: object.object_id,
      expectedVersion: 0,
      contentRef: 'artifact://stale-edit',
      digest: 'b'.repeat(64),
      authorEntityId: creator.entity_id
    }),
    (error) => error.code === '40001' && /stale world object version/.test(error.message)
  );

  const v2 = await publish({
    worldId,
    objectId: object.object_id,
    expectedVersion: 1,
    contentRef: 'artifact://merged-v2',
    digest: 'c'.repeat(64),
    authorEntityId: creator.entity_id,
    changeSummary: 'merge after reload'
  });
  assert.equal(v2.version, '2');
  assert.equal(v2.parent_version, '1');

  const versions = (await pool.query(
    `SELECT version, content_ref
       FROM social.object_versions
      WHERE world_id=$1 AND object_id=$2
      ORDER BY version`,
    [worldId, object.object_id]
  )).rows;
  assert.deepEqual(versions, [
    { version: '1', content_ref: 'artifact://draft-v1' },
    { version: '2', content_ref: 'artifact://merged-v2' }
  ]);
});

test('concurrent publications from the same observed version allow exactly one head advance', async () => {
  const worldId = nextWorld('concurrent');
  const { creator } = await createActors(worldId);
  const object = await createObject(worldId, creator.entity_id);

  const attempts = ['left', 'right'].map((side, index) => publish({
    worldId,
    objectId: object.object_id,
    expectedVersion: 0,
    contentRef: `artifact://${side}`,
    digest: String(index + 1).repeat(64),
    authorEntityId: creator.entity_id,
    changeSummary: side
  }));
  const settled = await Promise.allSettled(attempts);
  const fulfilled = settled.filter((result) => result.status === 'fulfilled');
  const rejected = settled.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, '40001');

  const state = (await pool.query(
    `SELECT o.current_version, count(v.*)::int AS version_count,
            array_agg(v.content_ref ORDER BY v.version) AS refs
       FROM social.world_objects o
       LEFT JOIN social.object_versions v
         ON v.world_id=o.world_id AND v.object_id=o.object_id
      WHERE o.world_id=$1 AND o.object_id=$2
      GROUP BY o.current_version`,
    [worldId, object.object_id]
  )).rows[0];
  assert.equal(state.current_version, '1');
  assert.equal(state.version_count, 1);
  assert.equal(state.refs.length, 1);

  await assert.rejects(
    () => pool.query(
      'UPDATE social.world_objects SET current_version=0 WHERE world_id=$1 AND object_id=$2',
      [worldId, object.object_id]
    ),
    (error) => error.code === '55000'
  );
});

test('parent_version is protected by a same-object composite foreign key', async () => {
  const worldId = nextWorld('parent-fk');
  const { creator } = await createActors(worldId);
  const object = await createObject(worldId, creator.entity_id);
  await publish({
    worldId,
    objectId: object.object_id,
    expectedVersion: 0,
    contentRef: 'artifact://v1',
    digest: 'd'.repeat(64),
    authorEntityId: creator.entity_id
  });

  const constraint = (await pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname='object_versions_parent_fkey'
        AND conrelid='objects.object_versions'::regclass`
  )).rows[0];
  assert.match(
    constraint.definition,
    /FOREIGN KEY \(world_id, object_id, parent_version\) REFERENCES objects\.object_versions\(world_id, object_id, version\)/
  );

  await pool.query(
    'ALTER TABLE objects.object_versions DISABLE TRIGGER object_versions_expected_version_guard'
  );
  await pool.query(
    'ALTER TABLE objects.object_versions DISABLE TRIGGER object_versions_advance_head'
  );
  try {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO objects.object_versions(
           world_id, object_id, version, expected_version, parent_version,
           content_ref, content_digest, author_entity_id
         ) VALUES ($1,$2,2,1,999,'artifact://bad-parent',$3,$4)`,
        [worldId, object.object_id, 'e'.repeat(64), creator.entity_id]
      ),
      (error) => error.code === '23503' && error.constraint === 'object_versions_parent_fkey'
    );
  } finally {
    await pool.query(
      'ALTER TABLE objects.object_versions ENABLE TRIGGER object_versions_advance_head'
    );
    await pool.query(
      'ALTER TABLE objects.object_versions ENABLE TRIGGER object_versions_expected_version_guard'
    );
  }
});

test('contributors and license refs are version-scoped, append-only evidence', async () => {
  const worldId = nextWorld('evidence');
  const { creator, contributor } = await createActors(worldId);
  const object = await createObject(worldId, creator.entity_id);

  await publish({
    worldId,
    objectId: object.object_id,
    expectedVersion: 0,
    contentRef: 'artifact://licensed-v1',
    digest: 'f'.repeat(64),
    authorEntityId: creator.entity_id,
    contributors: [{
      entity_id: contributor.entity_id,
      role: 'REVIEWER',
      contribution_ref: 'review://1'
    }],
    licenses: [{ license_ref: 'SPDX:MIT', scope: 'USE' }]
  });

  await publish({
    worldId,
    objectId: object.object_id,
    expectedVersion: 1,
    contentRef: 'artifact://licensed-v2',
    digest: '1'.repeat(64),
    authorEntityId: creator.entity_id,
    licenses: [{ license_ref: 'SPDX:Apache-2.0', scope: 'USE' }]
  });

  const contributors = (await pool.query(
    `SELECT version, contributor_entity_id, contribution_role
       FROM social.object_contributors
      WHERE world_id=$1 AND object_id=$2
      ORDER BY version, contribution_role, contributor_entity_id`,
    [worldId, object.object_id]
  )).rows;
  assert.equal(contributors.filter((row) => row.contribution_role === 'AUTHOR').length, 2);
  assert.ok(contributors.some(
    (row) => row.version === '1'
      && row.contributor_entity_id === contributor.entity_id
      && row.contribution_role === 'REVIEWER'
  ));

  const licenses = (await pool.query(
    `SELECT version, license_ref
       FROM social.object_license_refs
      WHERE world_id=$1 AND object_id=$2
      ORDER BY version`,
    [worldId, object.object_id]
  )).rows;
  assert.deepEqual(licenses, [
    { version: '1', license_ref: 'SPDX:MIT' },
    { version: '2', license_ref: 'SPDX:Apache-2.0' }
  ]);

  await assert.rejects(
    () => pool.query(
      `UPDATE social.object_license_refs
          SET license_ref='SPDX:GPL-3.0-only'
        WHERE world_id=$1 AND object_id=$2 AND version=1`,
      [worldId, object.object_id]
    ),
    (error) => error.code === '55000'
  );
});
