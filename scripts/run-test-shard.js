import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_KINDS = new Set(['unit', 'integration']);

export function selectShardFiles(files, shardIndex, shardTotal) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal)) {
    throw new TypeError('shard index and total must be integers');
  }
  if (shardTotal < 1 || shardIndex < 0 || shardIndex >= shardTotal) {
    throw new RangeError(`invalid shard ${shardIndex}/${shardTotal}`);
  }

  return [...files]
    .sort((a, b) => a.localeCompare(b))
    .filter((_, index) => index % shardTotal === shardIndex);
}

export function discoverTestFiles(kind) {
  if (!TEST_KINDS.has(kind)) {
    throw new Error(`unknown test kind: ${kind}`);
  }

  return readdirSync(`tests/${kind}`)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `tests/${kind}/${name}`);
}

export function buildNodeTestArgs(kind, files) {
  const args = ['--test'];
  if (kind === 'integration') args.push('--test-concurrency=1');
  args.push(...files);
  return args;
}

function main(argv) {
  const [kind, rawIndex, rawTotal] = argv;
  const shardIndex = Number(rawIndex);
  const shardTotal = Number(rawTotal);

  if (!TEST_KINDS.has(kind) || !/^\d+$/.test(rawIndex ?? '') || !/^\d+$/.test(rawTotal ?? '')) {
    console.error('usage: node scripts/run-test-shard.js <unit|integration> <zero-based-index> <total>');
    return 2;
  }

  const files = discoverTestFiles(kind);
  const selected = selectShardFiles(files, shardIndex, shardTotal);

  if (selected.length === 0) {
    console.error(`shard ${shardIndex}/${shardTotal} selected no ${kind} tests`);
    return 2;
  }

  console.log(`${kind} shard ${shardIndex + 1}/${shardTotal}:`);
  for (const file of selected) console.log(`  ${file}`);

  const result = spawnSync(process.execPath, buildNodeTestArgs(kind, selected), {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) process.exitCode = main(process.argv.slice(2));
