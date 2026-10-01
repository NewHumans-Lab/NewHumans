import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationDir = path.join(projectRoot, 'tests', 'integration');
const probeTable = 'nh_test_shard_isolation_probe';

export function databaseUrlFor(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function partitionFiles(files, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer');
  const ordered = [...files].sort();
  const count = Math.min(shardCount, Math.max(1, ordered.length));
  const shards = Array.from({ length: count }, () => []);
  ordered.forEach((file, index) => shards[index % count].push(file));
  return shards.filter((shard) => shard.length > 0);
}

export function makeDatabaseName(runId, shardIndex) {
  const safeRunId = String(runId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'run';
  const suffix = String(shardIndex).replace(/[^0-9]/g, '');
  return `nh_test_${safeRunId}_${suffix}`.slice(0, 63);
}

function childExit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

async function listIntegrationTests() {
  return (await fs.readdir(integrationDir))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('tests', 'integration', name));
}

async function createShardDatabase(adminPool, databaseName) {
  await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
}

async function dropShardDatabase(adminPool, databaseName) {
  await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
}

async function migrateShard(databaseUrl) {
  await childExit(process.execPath, ['scripts/migrate.js'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' }
  });
}

async function proveIsolation(shards, runId) {
  await Promise.all(shards.map(async (shard) => {
    const pool = new Pool({ connectionString: shard.databaseUrl, max: 2 });
    try {
      await pool.query(`CREATE TABLE public.${probeTable} (run_id text NOT NULL, shard_id integer NOT NULL)`);
      await pool.query(`INSERT INTO public.${probeTable} (run_id, shard_id) VALUES ($1, $2)`, [runId, shard.index]);
    } finally {
      await pool.end();
    }
  }));

  await Promise.all(shards.map(async (shard) => {
    const pool = new Pool({ connectionString: shard.databaseUrl, max: 2 });
    try {
      const result = await pool.query(`SELECT run_id, shard_id FROM public.${probeTable}`);
      if (result.rowCount !== 1 || result.rows[0].run_id !== runId || result.rows[0].shard_id !== shard.index) {
        throw new Error(`shard ${shard.index} can observe data outside its isolated database`);
      }
    } finally {
      await pool.end();
    }
  }));
}

async function assertNoResidualDatabases(adminPool, names) {
  const residual = await adminPool.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname', [names]);
  if (residual.rowCount) throw new Error(`test database cleanup left residual databases: ${residual.rows.map((row) => row.datname).join(', ')}`);
}

async function runShard(shard, shardCount, runId) {
  console.log(`[test-db-harness] shard ${shard.index + 1}/${shardCount}: ${shard.files.length} file(s) on ${shard.databaseName}`);
  await childExit(process.execPath, ['--test', '--test-concurrency=1', ...shard.files], {
    env: {
      ...process.env,
      DATABASE_URL: shard.databaseUrl,
      NODE_ENV: 'test',
      NH_TEST_RUN_ID: runId,
      NH_TEST_SHARD_ID: String(shard.index),
      NH_TEST_SHARD_COUNT: String(shardCount)
    }
  });
}

export async function runIntegrationPass({ shardCount = 4, label = 'parallel' } = {}) {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required for integration tests');
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || baseUrl;
  const files = await listIntegrationTests();
  if (!files.length) throw new Error('no integration test files found');

  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const partitions = partitionFiles(files, shardCount);
  const shards = partitions.map((shardFiles, index) => {
    const databaseName = makeDatabaseName(runId, index);
    return {
      index,
      files: shardFiles,
      databaseName,
      databaseUrl: databaseUrlFor(baseUrl, databaseName)
    };
  });
  const adminPool = new Pool({ connectionString: adminUrl, max: Math.max(4, shards.length) });
  const created = [];
  let passError;

  console.log(`[test-db-harness] ${label}: creating ${shards.length} isolated database shard(s)`);
  try {
    for (const shard of shards) {
      try {
        await createShardDatabase(adminPool, shard.databaseName);
      } catch (error) {
        if (error?.code === '42501') {
          throw new Error('integration test database harness requires CREATEDB permission; set TEST_DATABASE_ADMIN_URL to a PostgreSQL role with database create/drop permission', { cause: error });
        }
        throw error;
      }
      created.push(shard.databaseName);
    }

    await Promise.all(shards.map((shard) => migrateShard(shard.databaseUrl)));
    await proveIsolation(shards, runId);
    console.log(`[test-db-harness] ${label}: isolation probe PASS`);

    const settled = await Promise.allSettled(shards.map((shard) => runShard(shard, shards.length, runId)));
    const rejected = settled.filter((result) => result.status === 'rejected');
    if (rejected.length) throw rejected[0].reason;
    console.log(`[test-db-harness] ${label}: PASS`);
    return { files, shardCount: shards.length };
  } catch (error) {
    passError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const databaseName of created.reverse()) {
      try {
        await dropShardDatabase(adminPool, databaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await assertNoResidualDatabases(adminPool, created);
    } catch (error) {
      cleanupErrors.push(error);
    }
    await adminPool.end();
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, 'isolated test database cleanup failed');
      if (!passError) throw cleanupError;
      console.error(cleanupError);
    } else {
      console.log(`[test-db-harness] ${label}: cleanup PASS (no residual databases)`);
    }
  }
}

function parseShardCount(value, fallback = 4) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid shard count: ${value}`);
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  let shardCount = parseShardCount(process.env.NH_TEST_SHARDS, 4);
  let verifySerial = false;
  for (const arg of argv) {
    if (arg === '--verify-serial') verifySerial = true;
    else if (arg.startsWith('--shards=')) shardCount = parseShardCount(arg.slice('--shards='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (verifySerial) {
    const serial = await runIntegrationPass({ shardCount: 1, label: 'serial-baseline' });
    const parallel = await runIntegrationPass({ shardCount, label: `${shardCount}-way-parallel` });
    if (JSON.stringify(serial.files) !== JSON.stringify(parallel.files)) {
      throw new Error('serial and parallel integration manifests differ');
    }
    if (parallel.shardCount < Math.min(4, parallel.files.length) && shardCount >= 4) {
      throw new Error(`parallel acceptance expected at least 4 shards but ran ${parallel.shardCount}`);
    }
    console.log(`[test-db-harness] acceptance PASS: serial and ${parallel.shardCount}-way parallel executed the same ${parallel.files.length} files`);
    return;
  }

  await runIntegrationPass({ shardCount, label: `${shardCount}-way-parallel` });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
