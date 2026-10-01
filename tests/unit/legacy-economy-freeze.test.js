import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLegacyEconomyFreezeViolations } from '../../scripts/check-legacy-economy-freeze.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-legacy-economy-'));
  fs.mkdirSync(path.join(root, 'src/services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/http'), { recursive: true });
  fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/services/economy.js'), `
const LEGACY_ECONOMY_PRODUCTION_DISABLED = true;
export async function getWallet() {}
export async function mint() {}
export async function transfer() {}
export async function reserve() {}
export async function releaseReservation() {}
export async function settleReservation() {}
export async function firstActivation() {}
export async function chargeDailyActivityFee() {}
`);
  fs.writeFileSync(path.join(root, 'schemas/energy-wallet.schema.json'), JSON.stringify({
    title: 'Legacy Energy wallet nh.v3.0',
    type: 'object',
    required: ['world_id','entity_id','posted_balance_micro_e','reserved_micro_e','frozen_micro_e','available_micro_e'],
    properties: {
      world_id: {}, entity_id: {}, posted_balance_micro_e: {}, reserved_micro_e: {}, frozen_micro_e: {}, available_micro_e: {},
    },
    additionalProperties: false,
  }));
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('current repository satisfies NH-012 Legacy Economy freeze', () => {
  assert.deepEqual(collectLegacyEconomyFreezeViolations(process.cwd()), []);
});

test('Legacy Economy fails closed when loaded in production', () => {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import('./src/services/economy.js')
      .then(() => process.exit(2))
      .catch((error) => process.exit(error?.code === 'LEGACY_ECONOMY_PRODUCTION_DISABLED' ? 0 : 1));
  `], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
});

test('freeze rejects a new source importer but permits test-only usage by excluding tests from production-source scan', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'src/features'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/features/new-business.js'), "import { mint } from '../services/economy.js';\n");
  fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/unit/dev-only.js'), "import { mint } from '../../src/services/economy.js';\n");
  const violations = collectLegacyEconomyFreezeViolations(root);
  cleanup(root);
  assert.equal(violations.some((value) => value.includes('new source import')), true);
  assert.equal(violations.some((value) => value.includes('tests/unit/dev-only.js')), false);
});

test('freeze rejects new Legacy Economy exports', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, 'src/services/economy.js'), '\nexport async function createMarketplace() {}\n');
  const violations = collectLegacyEconomyFreezeViolations(root);
  cleanup(root);
  assert.equal(violations.some((value) => value.includes('exports expanded')), true);
});

test('freeze rejects Legacy wallet schema expansion', () => {
  const root = fixture();
  const file = path.join(root, 'schemas/energy-wallet.schema.json');
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  schema.properties.credit_limit_micro_e = {};
  fs.writeFileSync(file, JSON.stringify(schema));
  const violations = collectLegacyEconomyFreezeViolations(root);
  cleanup(root);
  assert.equal(violations.some((value) => value.includes('schema shape changed')), true);
});

test('freeze rejects new SQL migrations that extend economy schema', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'migrations/999_new_economy.sql'), 'ALTER TABLE economy.wallets ADD COLUMN x text;');
  const violations = collectLegacyEconomyFreezeViolations(root);
  cleanup(root);
  assert.equal(violations.some((value) => value.includes('new migration extends')), true);
});
