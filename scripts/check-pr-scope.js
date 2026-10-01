import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TASK_ID_RE = /^NH-\d{3,}$/;

export const BOOTSTRAP_TASK_ID = 'NH-019';
export const BOOTSTRAP_HEAD_REF = 'feat/nh-019-pr-scope-guard';
export const BOOTSTRAP_ALLOWED_PATHS = Object.freeze([
  '.github/pull_request_template.md',
  '.github/workflows/ci.yml',
  'scripts/check-pr-scope.js',
  'tests/unit/pr-scope-guard.test.js'
]);

const SCOPE_CONTROL_PATTERNS = Object.freeze([
  '.github/pull_request_template.md',
  '.github/task-scopes/**',
  '.github/workflows/ci.yml',
  'scripts/check-pr-scope.js',
  'tests/unit/pr-scope-guard.test.js'
]);

const SENSITIVE_SHARED_PATHS = Object.freeze([
  'migrations/013a_p3_runtime_pre_hardening_cleanup.sql',
  'migrations/014_p3_runtime_review_hardening.sql',
  'migrations/015a_p3_runtime_json_authority.sql',
  'migrations/015b_p3_runtime_lifecycle_authority.sql',
  'schemas/runtime-checkpoint.schema.json',
  'src/http/server.js',
  'src/services/p1_4.js',
  'src/services/runtime.js',
  'src/services/runtime_control.js',
  'src/services/runtime_policy.js',
  'src/services/runtime_scheduler.js',
  'tests/integration/p3_runtime_review_closure.test.js',
  'tests/integration/p3a_runtime.test.js',
  'tests/integration/p3b_runtime_authority.test.js'
]);

function fail(message) {
  throw new Error(message);
}

function normalizePathPattern(value) {
  if (typeof value !== 'string') fail('scope paths must be strings');
  const pattern = value.trim();
  if (!pattern) fail('scope paths must not be empty');
  if (pattern.includes('\\')) fail(`scope path must use forward slashes: ${pattern}`);
  if (pattern.startsWith('/')) fail(`scope path must be repository-relative: ${pattern}`);
  if (pattern === '**' || pattern === '/**') fail('repository-wide wildcard scope is forbidden');
  const wildcardCount = [...pattern].filter((char) => char === '*').length;
  if (wildcardCount > 0 && !(wildcardCount === 2 && pattern.endsWith('/**'))) {
    fail(`only exact paths or directory-prefix patterns ending in /** are allowed: ${pattern}`);
  }
  const base = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  const segments = base.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`scope path contains an invalid segment: ${pattern}`);
  }
  return pattern;
}

function normalizeAllowedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) fail('Allowed-Paths must contain at least one path');
  const normalized = paths.map(normalizePathPattern);
  if (new Set(normalized).size !== normalized.length) fail('Allowed-Paths must not contain duplicates');
  return normalized;
}

export function parseTaskId(body) {
  const matches = [...String(body || '').matchAll(/^Task-ID:\s*(NH-\d{3,})\s*$/gmi)];
  if (matches.length !== 1) {
    fail('PR must contain exactly one `Task-ID: NH-NNN` declaration.');
  }
  const taskId = matches[0][1].toUpperCase();
  if (!TASK_ID_RE.test(taskId)) fail(`invalid Task-ID: ${taskId}`);
  return taskId;
}

export function parseAllowedPaths(body) {
  const lines = String(body || '').split(/\r?\n/);
  const declarations = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^Allowed-Paths:\s*(.*)$/i);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline) {
      declarations.push(inline.split(';').map((value) => value.trim()).filter(Boolean));
      continue;
    }
    const paths = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item) {
        paths.push(item[1]);
        continue;
      }
      if (!line.trim()) break;
      break;
    }
    declarations.push(paths);
  }
  if (declarations.length !== 1) {
    fail('PR must contain exactly one `Allowed-Paths:` declaration.');
  }
  return normalizeAllowedPaths(declarations[0]);
}

export function isPathAllowed(filePath, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === pattern;
}

export function findOutOfScopePaths(changedPaths, allowedPaths) {
  const normalizedAllowed = normalizeAllowedPaths(allowedPaths);
  return [...new Set(changedPaths)]
    .filter((filePath) => !normalizedAllowed.some((pattern) => isPathAllowed(filePath, pattern)))
    .sort();
}

function setsEqual(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function validateRegistryScope(scope, expectedTaskId, headRef) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('task scope registry entry must be a JSON object');
  if (scope.task_id !== expectedTaskId) fail(`task scope registry mismatch: expected ${expectedTaskId}`);
  const allowedPaths = normalizeAllowedPaths(scope.allowed_paths);
  if (scope.head_ref !== undefined && scope.head_ref !== headRef) {
    fail(`task scope registry head_ref mismatch: expected ${scope.head_ref}, got ${headRef}`);
  }
  const capabilities = scope.capabilities === undefined ? [] : scope.capabilities;
  if (!Array.isArray(capabilities) || capabilities.some((value) => value !== 'PR_SCOPE_CONTROL')) {
    fail('task scope registry capabilities may only contain PR_SCOPE_CONTROL');
  }
  return { allowedPaths, capabilities };
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => isPathAllowed(filePath, pattern));
}

export function findProtectedPathViolations(changedPaths, context) {
  const { taskId, headRef, source, capabilities = [] } = context;
  const bootstrap = taskId === BOOTSTRAP_TASK_ID && headRef === BOOTSTRAP_HEAD_REF;
  const canEditScopeControl = bootstrap || (source === 'BASE_REGISTRY' && capabilities.includes('PR_SCOPE_CONTROL'));
  const currentRuntimeOwner = taskId === 'NH-001' && headRef === 'fix/p3-runtime-review-hardening';

  const violations = [];
  for (const filePath of new Set(changedPaths)) {
    if (!canEditScopeControl && matchesAny(filePath, SCOPE_CONTROL_PATTERNS)) {
      violations.push(`${filePath} (scope-control path requires trusted PR_SCOPE_CONTROL capability)`);
      continue;
    }
    if (source !== 'BASE_REGISTRY' && !currentRuntimeOwner && matchesAny(filePath, SENSITIVE_SHARED_PATHS)) {
      violations.push(`${filePath} (shared runtime hotspot requires a base-registered task scope)`);
    }
  }
  return violations.sort();
}

function gitOutput(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', options.stderr || 'pipe'] });
}

function gitShowMaybe(ref, repoPath) {
  const result = spawnSync('git', ['show', `${ref}:${repoPath}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

function readRegistryScope(baseSha, taskId) {
  const raw = gitShowMaybe(baseSha, `.github/task-scopes/${taskId}.json`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`base task scope registry is not valid JSON: ${error.message}`);
  }
}

function readChangedPaths(baseSha, headSha) {
  const mergeBase = gitOutput(['merge-base', baseSha, headSha]).trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeBase)) {
    fail('could not resolve a valid merge base for PR scope audit');
  }
  const raw = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', mergeBase, headSha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return raw.split('\0').filter(Boolean);
}

export function resolveScope({ taskId, headRef, declaredAllowedPaths, registryScope }) {
  if (registryScope) {
    const trusted = validateRegistryScope(registryScope, taskId, headRef);
    if (!setsEqual(declaredAllowedPaths, trusted.allowedPaths)) {
      fail('PR Allowed-Paths must exactly match the task scope registered on the base branch.');
    }
    return { ...trusted, source: 'BASE_REGISTRY' };
  }

  const bootstrap = taskId === BOOTSTRAP_TASK_ID && headRef === BOOTSTRAP_HEAD_REF;
  if (bootstrap && !setsEqual(declaredAllowedPaths, BOOTSTRAP_ALLOWED_PATHS)) {
    fail('NH-019 bootstrap Allowed-Paths must exactly match the built-in bootstrap scope.');
  }
  return { allowedPaths: declaredAllowedPaths, capabilities: [], source: 'PR_BODY_FALLBACK' };
}

export function auditScope({ taskId, headRef, declaredAllowedPaths, registryScope, changedPaths }) {
  const scope = resolveScope({ taskId, headRef, declaredAllowedPaths, registryScope });
  const outOfScope = findOutOfScopePaths(changedPaths, scope.allowedPaths);
  const protectedViolations = findProtectedPathViolations(changedPaths, {
    taskId,
    headRef,
    source: scope.source,
    capabilities: scope.capabilities
  });
  return { ...scope, outOfScope, protectedViolations };
}

export function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log('PR scope guard skipped: no GitHub event payload');
    return 0;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request;
  if (!pr) {
    console.log('PR scope guard skipped: not a pull request event');
    return 0;
  }

  const taskId = parseTaskId(pr.body || '');
  const declaredAllowedPaths = parseAllowedPaths(pr.body || '');
  const baseSha = pr.base?.sha;
  const headSha = pr.head?.sha;
  const headRef = pr.head?.ref;
  if (!/^[0-9a-f]{40}$/i.test(baseSha || '') || !/^[0-9a-f]{40}$/i.test(headSha || '') || !headRef) {
    fail('pull request event is missing a valid base SHA, head SHA, or head ref');
  }

  // The event base may advance while this PR is open. Audit only commits introduced
  // by the task branch, from its merge base with the current PR base through head.
  // CI checkout uses fetch-depth: 0 so both explicit commits and their ancestry exist.
  gitOutput(['cat-file', '-e', `${baseSha}^{commit}`]);
  gitOutput(['cat-file', '-e', `${headSha}^{commit}`]);

  const registryScope = readRegistryScope(baseSha, taskId);
  const changedPaths = readChangedPaths(baseSha, headSha);
  const result = auditScope({ taskId, headRef, declaredAllowedPaths, registryScope, changedPaths });

  if (result.outOfScope.length || result.protectedViolations.length) {
    if (result.outOfScope.length) {
      console.error('PR scope guard rejected out-of-scope paths:');
      for (const filePath of result.outOfScope) console.error(` - ${filePath}`);
    }
    if (result.protectedViolations.length) {
      console.error('PR scope guard rejected protected paths:');
      for (const detail of result.protectedViolations) console.error(` - ${detail}`);
    }
    return 1;
  }

  console.log(`PR scope guard accepted ${taskId}: ${changedPaths.length} changed path(s), source=${result.source}`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`PR scope guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}
