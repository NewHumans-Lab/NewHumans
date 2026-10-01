import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLegacyEconomyFreeze,
  LEGACY_ECONOMY_MODULE,
} from './check-legacy-economy-freeze.js';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const AUTHORITY_TABLE_PREFIXES = ['memory', 'memories', 'knowledge', 'belief', 'beliefs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const next = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(next) : [next];
  });
}

function repoPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function identifierTokens(identifier) {
  return identifier
    .replace(/"/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasAuthorityToken(identifier) {
  return identifierTokens(identifier).some((token) =>
    AUTHORITY_TABLE_PREFIXES.some((prefix) => token === prefix || token.startsWith(prefix)),
  );
}

function stripSqlComments(sql) {
  return sql
    .replace(/--[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function createdTables(sql) {
  const matches = [];
  const pattern = /\bCREATE\s+(?:(?:UNLOGGED|TEMPORARY|TEMP)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi;
  for (const match of sql.matchAll(pattern)) {
    matches.push({ identifier: match[1].replace(/\s+/g, ''), index: match.index ?? 0 });
  }
  return matches;
}

function createdSchemas(sql) {
  const matches = [];
  const pattern = /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/gi;
  for (const match of sql.matchAll(pattern)) {
    matches.push({ identifier: match[1], index: match.index ?? 0 });
  }
  return matches;
}

export function collectExternalAuthorityDependencyViolations(root = process.cwd()) {
  root = path.resolve(root);
  const violations = [];

  for (const file of walk(path.join(root, 'src'))) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
    const relative = repoPath(root, file);
    if (relative === LEGACY_ECONOMY_MODULE) continue;
    const source = fs.readFileSync(file, 'utf8');
    const walletPattern = /\b(?:FROM|JOIN)\s+["']?economy["']?\s*\.\s*["']?wallets["']?(?=$|[^\w$])/gim;
    for (const match of source.matchAll(walletPattern)) {
      violations.push({
        code: 'DIRECT_LEGACY_WALLET_READ',
        file: relative,
        line: lineNumberAt(source, match.index ?? 0),
        detail: 'production/source modules must not read the Legacy Economy wallet table directly; use EconomyPort',
      });
    }
  }

  for (const file of walk(path.join(root, 'migrations'))) {
    if (path.extname(file).toLowerCase() !== '.sql') continue;
    const relative = repoPath(root, file);
    const sql = fs.readFileSync(file, 'utf8');
    const executableSql = stripSqlComments(sql);

    for (const found of createdTables(executableSql)) {
      if (!hasAuthorityToken(found.identifier)) continue;
      violations.push({
        code: 'DUPLICATE_MEMORY_KNOWLEDGE_TABLE',
        file: relative,
        line: lineNumberAt(sql, found.index),
        detail: `NewHumans must not create a second memory/knowledge authority table (${found.identifier}); use MemoryPort/KnowledgePort`,
      });
    }

    for (const found of createdSchemas(executableSql)) {
      if (!hasAuthorityToken(found.identifier)) continue;
      violations.push({
        code: 'DUPLICATE_MEMORY_KNOWLEDGE_SCHEMA',
        file: relative,
        line: lineNumberAt(sql, found.index),
        detail: `NewHumans must not create a second memory/knowledge authority schema (${found.identifier}); use MemoryPort/KnowledgePort`,
      });
    }
  }

  return violations;
}

export function assertExternalAuthorityDependencies(root = process.cwd()) {
  // NH-012 remains the single authority for frozen Legacy Economy import/export/schema rules.
  assertLegacyEconomyFreeze(root);

  const violations = collectExternalAuthorityDependencyViolations(root);
  if (!violations.length) return;
  throw new Error([
    'NH-013 external authority dependency guard violations:',
    ...violations.map((violation) => `- [${violation.code}] ${violation.file}:${violation.line} ${violation.detail}`),
  ].join('\n'));
}

function cliRoot(argv) {
  const rootArgIndex = argv.indexOf('--root');
  if (rootArgIndex === -1) return process.cwd();
  if (!argv[rootArgIndex + 1]) throw new Error('--root requires a path');
  return path.resolve(argv[rootArgIndex + 1]);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    assertExternalAuthorityDependencies(cliRoot(process.argv.slice(2)));
    console.log('NH-013 external authority dependency guard passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
