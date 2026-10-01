import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY_AUTHORITY_TABLES = new Set([
  'migrations/001_p0_p1_foundation.sql:economy.wallets',
]);

const LEGACY_ECONOMY_IMPORTERS = new Set([
  'src/http/server.js',
  'src/services/gateway.js',
  'src/services/p1_4.js',
  'src/services/runtime_control.js',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function walkFiles(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    return entry.isDirectory() ? walkFiles(rootDir, relativePath) : [relativePath];
  });
}

function lineNumber(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

function authorityTableViolations(rootDir) {
  const violations = [];
  const createTable = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?([A-Za-z_][A-Za-z0-9_$]*)"?)\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/gi;
  const forbiddenAuthorityName = /(?:^|_)(?:memory|memories|knowledge|kb|wallet|wallets)(?:_|$)/i;

  for (const relativePath of walkFiles(rootDir, 'migrations').filter((file) => file.endsWith('.sql'))) {
    const file = posix(relativePath);
    const content = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const match of content.matchAll(createTable)) {
      const schema = match[1] ?? '';
      const table = match[2];
      if (!forbiddenAuthorityName.test(schema) && !forbiddenAuthorityName.test(table)) continue;
      const qualifiedName = schema ? `${schema}.${table}` : table;
      if (LEGACY_AUTHORITY_TABLES.has(`${file}:${qualifiedName.toLowerCase()}`)) continue;
      violations.push({
        code: 'AUTHORITY_TABLE',
        file,
        line: lineNumber(content, match.index),
        message: `NewHumans must not create Memory/Knowledge/Wallet authority table ${qualifiedName}; Knowledge Ball is the writable authority.`,
      });
    }
  }
  return violations;
}

function extractModuleSpecifiers(content) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...content.matchAll(pattern)].map((match) => ({ specifier: match[1], index: match.index })));
}

function targetsLegacyEconomy(file, specifier) {
  if (specifier.startsWith('.')) {
    const resolved = posix(path.normalize(path.join(path.dirname(file), specifier)));
    return resolved.replace(/\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i, '') === 'src/services/economy';
  }
  return /(?:^|\/)services\/economy(?:\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx))?$/i.test(specifier);
}

function economyImportViolations(rootDir) {
  const violations = [];
  for (const relativePath of walkFiles(rootDir, 'src').filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))) {
    const file = posix(relativePath);
    const content = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const { specifier, index } of extractModuleSpecifiers(content)) {
      if (!targetsLegacyEconomy(file, specifier) || LEGACY_ECONOMY_IMPORTERS.has(file)) continue;
      violations.push({
        code: 'ILLEGAL_ECONOMY_IMPORT',
        file,
        line: lineNumber(content, index),
        message: `Production code must use EconomyPort/Knowledge Ball, not legacy ${specifier}.`,
      });
    }
  }
  return violations;
}

function mockProviderViolations(rootDir) {
  const violations = [];
  const mockProviderIdentifier = /\b(?:[A-Za-z_$][\w$]*)?(?:mock|fake|stub)[\w$]*provider\b/i;
  const mockProviderLiteral = /\bprovider(?:Kind|Type|Name|Id)?\s*[:=]\s*['"](?:mock|fake|stub)(?:[-_ ][^'"]*)?['"]/i;

  for (const relativePath of walkFiles(rootDir, 'src').filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))) {
    const file = posix(relativePath);
    const content = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    const pathLooksMock = /(?:^|\/)(?:mock|fake|stub)[-_]?(?:model[-_]?)?provider\.[^.\/]+$/i.test(file)
      || /(?:^|\/)(?:providers?\/)?[^/]*(?:mock|fake|stub)[^/]*provider[^/]*\.[^.\/]+$/i.test(file);
    const match = mockProviderIdentifier.exec(content) ?? mockProviderLiteral.exec(content);
    if (!pathLooksMock && !match) continue;
    violations.push({
      code: 'PRODUCTION_MOCK_PROVIDER',
      file,
      line: match ? lineNumber(content, match.index) : 1,
      message: 'Mock/Fake/Stub model providers are test-only and must not exist under production src/.',
    });
  }
  return violations;
}

export function scanArchitecture(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);
  return [
    ...authorityTableViolations(root),
    ...economyImportViolations(root),
    ...mockProviderViolations(root),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
}

export function formatViolations(violations) {
  return violations.map((violation) => `${violation.code} ${violation.file}:${violation.line} ${violation.message}`).join('\n');
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  const violations = scanArchitecture(process.argv[2] ?? process.cwd());
  if (violations.length) {
    console.error(formatViolations(violations));
    process.exitCode = 1;
  } else {
    console.log('architecture regression scan passed');
  }
}
