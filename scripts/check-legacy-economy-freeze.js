import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEGACY_ECONOMY_MODULE = 'src/services/economy.js';
export const LEGACY_WALLET_SCHEMA = 'schemas/energy-wallet.schema.json';

const LEGACY_EXPORTS = new Set([
  'chargeDailyActivityFee',
  'firstActivation',
  'getWallet',
  'mint',
  'releaseReservation',
  'reserve',
  'settleReservation',
  'transfer',
]);

const EXISTING_SOURCE_IMPORTERS = new Set([
  'src/http/server.js',
  'src/services/gateway.js',
  'src/services/p1_4.js',
  'src/services/runtime_control.js',
]);

const HISTORICAL_MIGRATIONS = new Set([
  '001_p0_p1_foundation.sql',
  '002_p1_1_foundation_hardening.sql',
  '003_p1_2_m06_gateway.sql',
  '004_p1_3_m06_design_conformance.sql',
  '005_p1_4_final_contract_closure.sql',
  '006_p1_4_billing_evidence_immutability.sql',
  '007_p3a_m02_runtime_kernel.sql',
  '008_p3a_runtime_authority_hardening.sql',
  '009_p3b_continuous_runtime.sql',
  '010_p3b_goal_revision_actor_fix.sql',
  '011_p3b_wake_schedule_single_path.sql',
  '012_p3b_runtime_control_authority.sql',
  '013_p3b_active_state_guard.sql',
]);

const LEGACY_SCHEMA_PROPERTIES = new Set([
  'available_micro_e',
  'entity_id',
  'frozen_micro_e',
  'posted_balance_micro_e',
  'reserved_micro_e',
  'world_id',
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(next) : [next];
  });
}

function repoPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function setDiff(actual, expected) {
  return [...actual].filter((value) => !expected.has(value)).sort();
}

function staticImports(source) {
  const specs = [];
  const regex = /(?:\bimport\s+(?:[^'";]*?\sfrom\s*)?|\bexport\s+[^'";]*?\sfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(regex)) specs.push(match[1]);
  return specs;
}

export function collectLegacyEconomyFreezeViolations(root = process.cwd()) {
  const violations = [];
  const modulePath = path.join(root, LEGACY_ECONOMY_MODULE);
  const schemaPath = path.join(root, LEGACY_WALLET_SCHEMA);

  if (!fs.existsSync(modulePath)) {
    violations.push(`${LEGACY_ECONOMY_MODULE} is missing; deletion is outside NH-012 and requires a separate replacement/removal task`);
  } else {
    const source = fs.readFileSync(modulePath, 'utf8');
    const exports = new Set([...source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
    const added = setDiff(exports, LEGACY_EXPORTS);
    const removed = setDiff(LEGACY_EXPORTS, exports);
    if (added.length) violations.push(`legacy economy exports expanded: ${added.join(', ')}`);
    if (removed.length) violations.push(`legacy economy exports changed/removed in freeze task: ${removed.join(', ')}`);
    if (/\bexport\s+(?:default|\{|\*|class\s|const\s|let\s|var\s)/.test(source)) {
      violations.push('legacy economy gained a non-baseline export form');
    }
    if (!source.includes('LEGACY_ECONOMY_PRODUCTION_DISABLED')) {
      violations.push('legacy economy production fail-closed guard is missing');
    }
  }

  for (const file of walk(path.join(root, 'src')).filter((value) => value.endsWith('.js'))) {
    const rel = repoPath(root, file);
    if (rel === LEGACY_ECONOMY_MODULE) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of staticImports(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = repoPath(root, path.resolve(path.dirname(file), specifier));
      if (resolved === LEGACY_ECONOMY_MODULE && !EXISTING_SOURCE_IMPORTERS.has(rel)) {
        violations.push(`new source import of frozen ${LEGACY_ECONOMY_MODULE}: ${rel}`);
      }
    }
  }

  if (!fs.existsSync(schemaPath)) {
    violations.push(`${LEGACY_WALLET_SCHEMA} is missing; schema deletion is outside NH-012`);
  } else {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const props = new Set(Object.keys(schema.properties ?? {}));
    const required = new Set(schema.required ?? []);
    const addedProps = setDiff(props, LEGACY_SCHEMA_PROPERTIES);
    const removedProps = setDiff(LEGACY_SCHEMA_PROPERTIES, props);
    const requiredAdded = setDiff(required, LEGACY_SCHEMA_PROPERTIES);
    const requiredRemoved = setDiff(LEGACY_SCHEMA_PROPERTIES, required);
    if (addedProps.length || removedProps.length || requiredAdded.length || requiredRemoved.length) {
      violations.push('legacy energy-wallet schema shape changed; NH-012 freezes its interface');
    }
    if (schema.additionalProperties !== false) violations.push('legacy energy-wallet schema must remain closed');
    if (!String(schema.title ?? '').startsWith('Legacy ')) violations.push('legacy energy-wallet schema title must remain marked Legacy');
  }

  for (const file of walk(path.join(root, 'migrations')).filter((value) => value.endsWith('.sql'))) {
    const name = path.basename(file);
    if (HISTORICAL_MIGRATIONS.has(name)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    if (/\beconomy\s*\.|\b(?:create|alter|drop)\s+schema\s+(?:if\s+(?:not\s+)?exists\s+)?economy\b/i.test(sql)) {
      violations.push(`new migration extends frozen NewHumans economy schema: migrations/${name}`);
    }
  }

  return violations;
}

export function assertLegacyEconomyFreeze(root = process.cwd()) {
  const violations = collectLegacyEconomyFreezeViolations(root);
  if (violations.length) {
    throw new Error(`NH-012 Legacy Economy freeze violations:\n- ${violations.join('\n- ')}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  assertLegacyEconomyFreeze();
  console.log('NH-012 Legacy Economy freeze checks passed');
}
