import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MigrationOrderError,
  parseMigrationName,
  validateAppliedMigrationMetadata,
  validateMigrationFiles,
} from '../../scripts/migration-order.js';

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof MigrationOrderError);
    assert.equal(error.code, code);
    return true;
  });
}

test('accepts the repository migrations and returns canonical sequence order', async () => {
  const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const names = await fs.readdir(dir);
  const ordered = validateMigrationFiles(names);
  const sequences = ordered.map((name) => parseMigrationName(name).sequence);

  assert.equal(ordered.length, names.length);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.deepEqual(
    validateAppliedMigrationMetadata(ordered, ordered.map((name) => ({ name }))),
    new Set(ordered),
  );
});

test('sorts grandfathered letter variants and partitioned migrations canonically', () => {
  const ordered = validateMigrationFiles([
    '0300_m01_identity.sql',
    '015b_p3_runtime_lifecycle_authority.sql',
    '013a_p3_runtime_pre_hardening_cleanup.sql',
    '003_legacy_third.sql',
    '0160_runtime_hotfix.sql',
    '014_p3_runtime_review_hardening.sql',
    '015a_p3_runtime_json_authority.sql',
    '013_p3b_active_state_guard.sql',
  ]);

  assert.deepEqual(ordered, [
    '003_legacy_third.sql',
    '013_p3b_active_state_guard.sql',
    '013a_p3_runtime_pre_hardening_cleanup.sql',
    '014_p3_runtime_review_hardening.sql',
    '015a_p3_runtime_json_authority.sql',
    '015b_p3_runtime_lifecycle_authority.sql',
    '0160_runtime_hotfix.sql',
    '0300_m01_identity.sql',
  ]);
});

test('rejects duplicate migration sequence numbers', () => {
  assertCode(
    () => validateMigrationFiles(['300_legacy_collision.sql', '0300_partition_collision.sql']),
    'DUPLICATE_MIGRATION_SEQUENCE',
  );
});

test('rejects out-of-order applied metadata that skips an earlier migration', () => {
  const ordered = validateMigrationFiles([
    '001_first.sql',
    '002_second.sql',
    '003_third.sql',
  ]);

  assertCode(
    () => validateAppliedMigrationMetadata(ordered, [{ name: '001_first.sql' }, { name: '003_third.sql' }]),
    'OUT_OF_ORDER_MIGRATION_METADATA',
  );
});

test('rejects illegal migration names and suffixes', () => {
  assertCode(() => validateMigrationFiles(['014_bad.sql.bak']), 'INVALID_MIGRATION_SUFFIX');
  assertCode(() => validateMigrationFiles(['14_missing_padding.sql']), 'INVALID_MIGRATION_NAME');
  assertCode(() => validateMigrationFiles(['00300_too_many_digits.sql']), 'INVALID_MIGRATION_NAME');
  assertCode(() => validateMigrationFiles(['014_Uppercase.sql']), 'INVALID_MIGRATION_NAME');
});

test('rejects migration metadata for a file no longer present in the repository', () => {
  const ordered = validateMigrationFiles(['001_first.sql', '002_second.sql']);

  assertCode(
    () => validateAppliedMigrationMetadata(ordered, [{ name: '001_first.sql' }, { name: '003_removed.sql' }]),
    'UNKNOWN_APPLIED_MIGRATION',
  );
});

test('rejects duplicate migration metadata rows before execution', () => {
  const ordered = validateMigrationFiles(['001_first.sql', '002_second.sql']);

  assertCode(
    () => validateAppliedMigrationMetadata(ordered, [{ name: '001_first.sql' }, { name: '001_first.sql' }]),
    'DUPLICATE_MIGRATION_METADATA',
  );
});
