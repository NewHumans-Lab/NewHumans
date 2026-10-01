export const MIGRATION_NAMESPACES = Object.freeze([
  Object.freeze({ key: 'M01', token: 'm01', start: 300, end: 399, responsibility: 'World Core' }),
  Object.freeze({ key: 'M02', token: 'm02', start: 400, end: 499, responsibility: 'Agent Life Runtime' }),
  Object.freeze({ key: 'M04', token: 'm04', start: 500, end: 599, responsibility: 'Social Collaboration' }),
  Object.freeze({ key: 'M06', token: 'm06', start: 600, end: 699, responsibility: 'Model and Tool Gateway' }),
  Object.freeze({ key: 'INFRA', token: 'infra', start: 700, end: 799, responsibility: 'Cross-module infrastructure' }),
]);

// The pre-namespace history is immutable. PR #17 was already open when the namespace
// policy was introduced, so its existing migration files are grandfathered explicitly.
// Anything else below 0300 is rejected instead of extending the old global counter.
export const LEGACY_MIGRATION_ALLOWLIST = Object.freeze([
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
  '013a_p3_runtime_pre_hardening_cleanup.sql',
  '014_p3_runtime_review_hardening.sql',
  '015a_p3_runtime_json_authority.sql',
  '015b_p3_runtime_lifecycle_authority.sql',
]);

// This migration landed on main during NH-014's concurrent integration window before
// the guard became authoritative. Applied migration filenames are immutable, so the
// exact historical filename is frozen without admitting any new NNNNa-style names.
export const PRE_POLICY_FILENAME_EXCEPTIONS = Object.freeze([
  '0527a_m04_organization_reference_locking.sql',
]);

const legacyMigrationSet = new Set(LEGACY_MIGRATION_ALLOWLIST);
const prePolicyExceptionSet = new Set(PRE_POLICY_FILENAME_EXCEPTIONS);
const namespacedMigrationPattern = /^(?<number>\d{4})_(?<namespace>m01|m02|m04|m06|infra)_(?<slug>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

function namespaceFor(number) {
  return MIGRATION_NAMESPACES.find(({ start, end }) => number >= start && number <= end) ?? null;
}

export function validateMigrationNames(names) {
  if (!Array.isArray(names)) throw new TypeError('migration names must be an array');

  const violations = [];
  const seenNumbers = new Map();

  for (const name of names) {
    if (typeof name !== 'string') {
      violations.push(`non-string migration entry: ${String(name)}`);
      continue;
    }
    if (legacyMigrationSet.has(name) || prePolicyExceptionSet.has(name)) continue;

    const match = namespacedMigrationPattern.exec(name);
    if (!match) {
      violations.push(`${name}: expected NNNN_<m01|m02|m04|m06|infra>_<snake_case_slug>.sql and is not an approved historical migration`);
      continue;
    }

    const number = Number.parseInt(match.groups.number, 10);
    const namespace = namespaceFor(number);
    if (!namespace) {
      violations.push(`${name}: migration number ${match.groups.number} is outside allocated ranges 0300-0799`);
    } else if (match.groups.namespace !== namespace.token) {
      violations.push(`${name}: migration number ${match.groups.number} belongs to ${namespace.key} and must use token ${namespace.token}`);
    }

    const previous = seenNumbers.get(number);
    if (previous) {
      violations.push(`${name}: duplicate migration number ${match.groups.number}; already used by ${previous}`);
    } else {
      seenNumbers.set(number, name);
    }
  }

  if (violations.length > 0) {
    throw new Error(`Migration namespace policy violations:\n- ${violations.join('\n- ')}`);
  }

  return [...names].sort();
}
