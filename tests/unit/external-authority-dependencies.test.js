import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../scripts/check-external-authority-dependencies.js');

const legacyEconomyBaseline = `
if (process.env.NODE_ENV === 'production') throw Object.assign(new Error('disabled'), { code: 'LEGACY_ECONOMY_PRODUCTION_DISABLED' });
export async function chargeDailyActivityFee() {}
export async function firstActivation() {}
export async function getWallet() {}
export async function mint() {}
export async function releaseReservation() {}
export async function reserve() {}
export async function settleReservation() {}
export async function transfer() {}
`;

const legacyWalletSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Legacy Energy Wallet',
  type: 'object',
  additionalProperties: false,
  required: [
    'available_micro_e',
    'entity_id',
    'frozen_micro_e',
    'posted_balance_micro_e',
    'reserved_micro_e',
    'world_id',
  ],
  properties: {
    available_micro_e: {},
    entity_id: {},
    frozen_micro_e: {},
    posted_balance_micro_e: {},
    reserved_micro_e: {},
    world_id: {},
  },
}, null, 2);

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-013-'));
  const all = {
    'src/services/economy.js': legacyEconomyBaseline,
    'schemas/energy-wallet.schema.json': `${legacyWalletSchema}\n`,
    ...files,
  };
  for (const [relative, source] of Object.entries(all)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

test('combined check fails for a new direct Legacy Economy import', () => {
  const result = run(fixture({
    'src/features/new-feature.js': "import { getWallet } from '../services/economy.js';\n",
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NH-012 Legacy Economy freeze violations/);
});

test('legal KnowledgePort import passes', () => {
  const result = run(fixture({
    'src/features/new-feature.js': "import { readKnowledge } from '../ports/knowledge_port.js';\n",
  }));
  assert.equal(result.status, 0, result.stderr);
});

test('direct Legacy Economy wallet-table read fails', () => {
  const result = run(fixture({
    'src/features/new-feature.js': "export const q = 'select * from economy.wallets';\n",
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DIRECT_LEGACY_WALLET_READ/);
});

test('new memory and knowledge authority tables fail', () => {
  const result = run(fixture({
    'migrations/999_bad.sql': 'CREATE TABLE runtime.agent_memory (id uuid);\nCREATE TABLE knowledge.nodes (id uuid);\n',
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DUPLICATE_MEMORY_KNOWLEDGE_TABLE/);
});

test('new knowledge authority schema fails', () => {
  const result = run(fixture({
    'migrations/999_bad.sql': 'CREATE SCHEMA IF NOT EXISTS knowledge;\n',
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DUPLICATE_MEMORY_KNOWLEDGE_SCHEMA/);
});

test('unrelated integration table passes', () => {
  const result = run(fixture({
    'migrations/999_ok.sql': 'CREATE TABLE integration.outbox (id uuid);\n',
  }));
  assert.equal(result.status, 0, result.stderr);
});
