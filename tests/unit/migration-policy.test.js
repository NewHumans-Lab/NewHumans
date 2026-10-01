import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_MIGRATION_ALLOWLIST,
  MIGRATION_NAMESPACES,
  PRE_POLICY_FILENAME_EXCEPTIONS,
  validateMigrationNames,
} from '../../scripts/migration-policy.js';

test('namespace table is non-overlapping and covers the allocated 03xx-07xx ranges', () => {
  assert.deepEqual(
    MIGRATION_NAMESPACES.map(({ key, token, start, end }) => [key, token, start, end]),
    [
      ['M01', 'm01', 300, 399],
      ['M02', 'm02', 400, 499],
      ['M04', 'm04', 500, 599],
      ['M06', 'm06', 600, 699],
      ['INFRA', 'infra', 700, 799],
    ],
  );
});

test('approved historical migrations and valid namespaced migrations pass', () => {
  assert.doesNotThrow(() => validateMigrationNames([
    ...LEGACY_MIGRATION_ALLOWLIST,
    ...PRE_POLICY_FILENAME_EXCEPTIONS,
    '0300_m01_identity_binding.sql',
    '0407_m02_runtime_resume_guard.sql',
    '0521_m04_contract_threads.sql',
    '0612_m06_connector_rotation.sql',
    '0799_infra_schema_metadata.sql',
  ]));
});

test('duplicate namespaced migration numbers fail even when filenames differ', () => {
  assert.throws(
    () => validateMigrationNames([
      '0301_m01_entity_guard.sql',
      '0301_m01_action_guard.sql',
    ]),
    /duplicate migration number 0301/,
  );
});

test('a migration using the wrong namespace token for its range fails', () => {
  assert.throws(
    () => validateMigrationNames(['0401_m01_wrong_owner.sql']),
    /belongs to M02 and must use token m02/,
  );
});

test('unallocated or legacy-style new migration numbers fail', () => {
  assert.throws(
    () => validateMigrationNames(['0800_infra_future_range.sql']),
    /outside allocated ranges 0300-0799/,
  );
  assert.throws(
    () => validateMigrationNames(['016_p3b_old_global_counter.sql']),
    /not an approved historical migration/,
  );
});

test('malformed namespace filenames and new suffix variants fail', () => {
  assert.throws(
    () => validateMigrationNames(['0302_runtime_missing_namespace.sql']),
    /expected NNNN_/,
  );
  assert.throws(
    () => validateMigrationNames(['0302_m01_Not_Snake_Case.sql']),
    /expected NNNN_/,
  );
  assert.throws(
    () => validateMigrationNames(['0528a_m04_new_suffix.sql']),
    /expected NNNN_/,
  );
});
