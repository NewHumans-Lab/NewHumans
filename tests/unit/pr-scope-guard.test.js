import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BOOTSTRAP_ALLOWED_PATHS,
  auditScope,
  findOutOfScopePaths,
  findProtectedPathViolations,
  parseAllowedPaths,
  parseTaskId,
  resolveScope
} from '../../scripts/check-pr-scope.js';

const guardScript = fileURLToPath(new URL('../../scripts/check-pr-scope.js', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-pr-scope-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'scope-test@example.invalid');
  git(cwd, 'config', 'user.name', 'Scope Guard Test');
  fs.mkdirSync(path.join(cwd, 'schemas', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'schemas', 'foo', 'base.json'), '{}\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  const baseBranch = git(cwd, 'branch', '--show-current');
  git(cwd, 'checkout', '-qb', 'feat/nh-777-scope-test');
  return { cwd, baseSha, baseBranch };
}

function runGuard(cwd, event) {
  const eventPath = path.join(cwd, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  return spawnSync(process.execPath, [guardScript], {
    cwd,
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: 'utf8'
  });
}

test('parses exactly one task id and block Allowed-Paths declaration', () => {
  const body = `Task-ID: NH-123\nAllowed-Paths:\n- schemas/foo/**\n- tests/unit/foo.test.js\n\n## Verification`;
  assert.equal(parseTaskId(body), 'NH-123');
  assert.deepEqual(parseAllowedPaths(body), ['schemas/foo/**', 'tests/unit/foo.test.js']);
});

test('directory-prefix scope accepts descendants and rejects unrelated runtime paths', () => {
  assert.deepEqual(findOutOfScopePaths(['schemas/foo/a.json'], ['schemas/foo/**']), []);
  assert.deepEqual(findOutOfScopePaths(['schemas/foo/a.json', 'src/services/runtime.js'], ['schemas/foo/**']), ['src/services/runtime.js']);
});

test('fallback scope cannot authorize shared runtime hotspots by merely listing them', () => {
  const violations = findProtectedPathViolations(['src/services/runtime.js'], {
    taskId: 'NH-777',
    headRef: 'feat/nh-777-scope-test',
    source: 'PR_BODY_FALLBACK',
    capabilities: []
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /shared runtime hotspot/);
});

test('current NH-001 runtime owner may touch current runtime hotspots but not scope-control files', () => {
  const violations = findProtectedPathViolations(['src/services/runtime.js', '.github/workflows/ci.yml'], {
    taskId: 'NH-001',
    headRef: 'fix/p3-runtime-review-hardening',
    source: 'PR_BODY_FALLBACK',
    capabilities: []
  });
  assert.deepEqual(violations, ['.github/workflows/ci.yml (scope-control path requires trusted PR_SCOPE_CONTROL capability)']);
});

test('NH-019 bootstrap scope cannot be widened', () => {
  assert.throws(() => resolveScope({
    taskId: 'NH-019',
    headRef: 'feat/nh-019-pr-scope-guard',
    declaredAllowedPaths: [...BOOTSTRAP_ALLOWED_PATHS, 'src/services/runtime.js'],
    registryScope: null
  }), /must exactly match/);
});

test('base registry scope is authoritative over PR body declaration', () => {
  assert.throws(() => auditScope({
    taskId: 'NH-200',
    headRef: 'feat/nh-200',
    declaredAllowedPaths: ['schemas/foo/**', 'src/**'],
    registryScope: { task_id: 'NH-200', head_ref: 'feat/nh-200', allowed_paths: ['schemas/foo/**'] },
    changedPaths: ['schemas/foo/a.json']
  }), /must exactly match/);
});

test('constructed unauthorized git diff fails the executable guard', () => {
  const { cwd, baseSha } = initRepo();
  fs.mkdirSync(path.join(cwd, 'src', 'services'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'services', 'runtime.js'), 'export const changed = true;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'unauthorized runtime change');
  const headSha = git(cwd, 'rev-parse', 'HEAD');

  const body = `Task-ID: NH-777\nAllowed-Paths:\n- schemas/foo/**`;
  const result = runGuard(cwd, {
    pull_request: {
      body,
      base: { sha: baseSha },
      head: { sha: headSha, ref: 'feat/nh-777-scope-test' }
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PR scope guard rejected out-of-scope paths/);
  assert.match(result.stderr, /src\/services\/runtime\.js/);
});

test('constructed in-scope git diff passes the executable guard', () => {
  const { cwd, baseSha } = initRepo();
  fs.writeFileSync(path.join(cwd, 'schemas', 'foo', 'allowed.json'), '{"ok":true}\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'allowed schema change');
  const headSha = git(cwd, 'rev-parse', 'HEAD');

  const body = `Task-ID: NH-777\nAllowed-Paths:\n- schemas/foo/**`;
  const result = runGuard(cwd, {
    pull_request: {
      body,
      base: { sha: baseSha },
      head: { sha: headSha, ref: 'feat/nh-777-scope-test' }
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted NH-777/);
});

test('base-only commits added after branching are not charged to the task diff', () => {
  const { cwd, baseBranch } = initRepo();

  fs.writeFileSync(path.join(cwd, 'schemas', 'foo', 'allowed.json'), '{"ok":true}\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'task-owned schema change');
  const headSha = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-q', baseBranch);
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'migration-order.js'), 'export const baseOnly = true;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base advances independently');
  const advancedBaseSha = git(cwd, 'rev-parse', 'HEAD');

  const body = `Task-ID: NH-777\nAllowed-Paths:\n- schemas/foo/**`;
  const result = runGuard(cwd, {
    pull_request: {
      body,
      base: { sha: advancedBaseSha },
      head: { sha: headSha, ref: 'feat/nh-777-scope-test' }
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted NH-777: 1 changed path/);
});
