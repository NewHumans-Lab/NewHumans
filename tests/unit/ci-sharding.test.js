import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNodeTestArgs, selectShardFiles } from '../../scripts/run-test-shard.js';

test('shards are deterministic, disjoint, and exhaustive', () => {
  const files = [
    'tests/unit/z.test.js',
    'tests/unit/a.test.js',
    'tests/unit/d.test.js',
    'tests/unit/b.test.js',
    'tests/unit/c.test.js',
  ];

  const shards = Array.from({ length: 3 }, (_, index) => selectShardFiles(files, index, 3));
  const flattened = shards.flat();

  assert.deepEqual(
    [...flattened].sort(),
    [...files].sort(),
    'every test file must be assigned to a shard',
  );
  assert.equal(new Set(flattened).size, files.length, 'no test file may run in more than one shard');
  assert.deepEqual(selectShardFiles(files, 1, 3), selectShardFiles([...files].reverse(), 1, 3));
});

test('a broken test file belongs to exactly one shard', () => {
  const files = Array.from({ length: 11 }, (_, index) => `tests/integration/t${index}.test.js`);
  const broken = 'tests/integration/t7.test.js';
  const owners = Array.from({ length: 4 }, (_, index) => selectShardFiles(files, index, 4))
    .filter((filesInShard) => filesInShard.includes(broken));

  assert.equal(owners.length, 1);
});

test('integration shard preserves serial execution inside each isolated database job', () => {
  assert.deepEqual(
    buildNodeTestArgs('integration', ['tests/integration/a.test.js']),
    ['--test', '--test-concurrency=1', 'tests/integration/a.test.js'],
  );
  assert.deepEqual(
    buildNodeTestArgs('unit', ['tests/unit/a.test.js']),
    ['--test', 'tests/unit/a.test.js'],
  );
});

test('invalid shard coordinates fail closed', () => {
  assert.throws(() => selectShardFiles(['a'], -1, 2), RangeError);
  assert.throws(() => selectShardFiles(['a'], 2, 2), RangeError);
  assert.throws(() => selectShardFiles(['a'], 0, 0), RangeError);
});
