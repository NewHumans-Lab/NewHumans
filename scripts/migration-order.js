const MIGRATION_NAME = /^(?<number>\d{3,4})(?<variant>[a-z]?)(?:_(?<slug>[a-z0-9]+(?:_[a-z0-9]+)*))\.sql$/;

export class MigrationOrderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationOrderError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MigrationOrderError(code, message);
}

function variantRank(variant) {
  return variant ? variant.charCodeAt(0) - 96 : 0;
}

export function parseMigrationName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    fail('INVALID_MIGRATION_NAME', 'migration filename must be a non-empty string');
  }

  if (!name.endsWith('.sql')) {
    fail('INVALID_MIGRATION_SUFFIX', `migration file must end with .sql: ${name}`);
  }

  const match = MIGRATION_NAME.exec(name);
  if (!match) {
    fail(
      'INVALID_MIGRATION_NAME',
      `migration filename must use a 3-4 digit prefix, optional legacy letter, and lowercase snake_case slug: ${name}`,
    );
  }

  const sequence = Number(match.groups.number);
  if (sequence === 0) {
    fail('INVALID_MIGRATION_SEQUENCE', `migration sequence must be greater than zero: ${name}`);
  }

  const variant = match.groups.variant || '';
  return {
    name,
    sequence,
    variant,
    variantRank: variantRank(variant),
    orderKey: `${sequence}:${variant || '-'}`,
  };
}

export function validateMigrationFiles(fileNames) {
  if (!Array.isArray(fileNames)) {
    fail('INVALID_MIGRATION_INPUT', 'migration filenames must be provided as an array');
  }

  const seenNames = new Set();
  const seenOrderKeys = new Map();
  const parsed = [];

  for (const name of fileNames) {
    const migration = parseMigrationName(name);

    if (seenNames.has(name)) {
      fail('DUPLICATE_MIGRATION_NAME', `duplicate migration filename: ${name}`);
    }
    seenNames.add(name);

    const existing = seenOrderKeys.get(migration.orderKey);
    if (existing) {
      fail(
        'DUPLICATE_MIGRATION_SEQUENCE',
        `migration order key ${migration.orderKey} is used by both ${existing} and ${name}`,
      );
    }
    seenOrderKeys.set(migration.orderKey, name);
    parsed.push(migration);
  }

  parsed.sort(
    (a, b) => a.sequence - b.sequence
      || a.variantRank - b.variantRank
      || a.name.localeCompare(b.name),
  );
  return parsed.map(({ name }) => name);
}

function normalizeAppliedName(row) {
  if (typeof row === 'string') return row;
  if (row && typeof row === 'object' && typeof row.name === 'string') return row.name;
  fail('INVALID_MIGRATION_METADATA', 'applied migration metadata must contain a string name');
}

export function validateAppliedMigrationMetadata(orderedFiles, appliedRows) {
  const canonicalFiles = validateMigrationFiles(orderedFiles);
  if (!Array.isArray(appliedRows)) {
    fail('INVALID_MIGRATION_METADATA', 'applied migration metadata must be provided as an array');
  }

  const known = new Set(canonicalFiles);
  const applied = new Set();

  for (const row of appliedRows) {
    const name = normalizeAppliedName(row);
    parseMigrationName(name);

    if (applied.has(name)) {
      fail('DUPLICATE_MIGRATION_METADATA', `duplicate applied migration metadata: ${name}`);
    }
    if (!known.has(name)) {
      fail('UNKNOWN_APPLIED_MIGRATION', `applied migration is not present in the repository: ${name}`);
    }
    applied.add(name);
  }

  const expectedPrefix = canonicalFiles.slice(0, applied.size);
  for (const name of expectedPrefix) {
    if (!applied.has(name)) {
      const missingIndex = canonicalFiles.indexOf(name);
      const later = canonicalFiles.slice(missingIndex + 1).find((candidate) => applied.has(candidate));
      fail(
        'OUT_OF_ORDER_MIGRATION_METADATA',
        `applied migration metadata is not a canonical prefix; missing ${name}${later ? ` before ${later}` : ''}`,
      );
    }
  }

  return applied;
}
