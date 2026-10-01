import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrlFor, makeDatabaseName, partitionFiles } from '../../scripts/test-db-harness.js';

test('partitionFiles covers each file exactly once across four shards', () => {
  const files = ['g.test.js', 'a.test.js', 'f.test.js', 'b.test.js', 'e.test.js', 'c.test.js', 'd.test.js', 'h.test.js'];
  const shards = partitionFiles(files, 4);
  assert.equal(shards.length, 4);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.ok(shards.every((shard) => shard.length === 2));
});

test('partitionFiles never creates empty shards', () => {
  assert.deepEqual(partitionFiles(['b', 'a'], 4), [['a'], ['b']]);
  assert.throws(() => partitionFiles(['a'], 0), /positive integer/);
});

test('databaseUrlFor only replaces the database component', () => {
  const result = new URL(databaseUrlFor('postgres://user:pass@db.example:5432/base?sslmode=require', 'nh_test_abc_0'));
  assert.equal(result.username, 'user');
  assert.equal(result.password, 'pass');
  assert.equal(result.hostname, 'db.example');
  assert.equal(result.port, '5432');
  assert.equal(result.pathname, '/nh_test_abc_0');
  assert.equal(result.searchParams.get('sslmode'), 'require');
});

test('makeDatabaseName is PostgreSQL-safe and bounded', () => {
  const name = makeDatabaseName('RUN-unsafe/with spaces/and symbols !!! plus very long suffix 1234567890', 3);
  assert.match(name, /^nh_test_[a-z0-9]+_3$/);
  assert.ok(name.length <= 63);
});
