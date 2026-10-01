import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  REQUIRED_TASK_ACCEPTANCE_FIELDS,
  parseTaskAcceptance,
  validateTaskAcceptance,
} from '../../scripts/task-acceptance.js';

const MERGE_SHA = '0123456789abcdef0123456789abcdef01234567';

function body(overrides = {}) {
  const values = {
    'Task-ID': 'NH-018',
    Scope: 'Task acceptance protocol, checker, templates, and tests only',
    Tests: 'node --test tests/unit/task_acceptance.test.js; npm run check; npm test',
    'Self-Review': 'APPROVED',
    'Known-Limitations': 'NONE',
    'Merge-SHA': 'PENDING',
    ...overrides,
  };
  return REQUIRED_TASK_ACCEPTANCE_FIELDS.map((field) => `${field}: ${values[field]}`).join('\n');
}

test('valid premerge acceptance passes', () => {
  const result = validateTaskAcceptance(body(), { phase: 'premerge' });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('valid final acceptance requires and matches merge SHA', () => {
  const result = validateTaskAcceptance(body({ 'Merge-SHA': MERGE_SHA }), {
    phase: 'final',
    expectedMergeSha: MERGE_SHA,
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('every required field is fail-closed when missing', async (t) => {
  for (const missing of REQUIRED_TASK_ACCEPTANCE_FIELDS) {
    await t.test(missing, () => {
      const incomplete = body()
        .split('\n')
        .filter((line) => !line.startsWith(`${missing}:`))
        .join('\n');
      const result = validateTaskAcceptance(incomplete, { phase: 'premerge' });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), new RegExp(missing.replace('-', '\\-')));
    });
  }
});

test('duplicate required fields fail', () => {
  const result = validateTaskAcceptance(`${body()}\nScope: duplicate`, { phase: 'premerge' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Scope must appear exactly once/);
});

test('self review must be approved', () => {
  const result = validateTaskAcceptance(body({ 'Self-Review': 'PENDING' }), { phase: 'premerge' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Self-Review must be APPROVED/);
});

test('scope and tests reject placeholders', () => {
  for (const field of ['Scope', 'Tests']) {
    const result = validateTaskAcceptance(body({ [field]: 'TODO' }), { phase: 'premerge' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(`${field} must contain concrete evidence`));
  }
});

test('known limitations must be explicit', () => {
  const result = validateTaskAcceptance(body({ 'Known-Limitations': 'N/A' }), { phase: 'premerge' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Known-Limitations must be NONE or a concrete limitation statement/);
});

test('premerge and final merge SHA phases are distinct', () => {
  const premature = validateTaskAcceptance(body({ 'Merge-SHA': MERGE_SHA }), { phase: 'premerge' });
  assert.equal(premature.ok, false);
  assert.match(premature.errors.join('\n'), /must be PENDING before merge/);

  const pendingFinal = validateTaskAcceptance(body(), { phase: 'final', expectedMergeSha: MERGE_SHA });
  assert.equal(pendingFinal.ok, false);
  assert.match(pendingFinal.errors.join('\n'), /40-character merge commit SHA/);

  const mismatch = validateTaskAcceptance(body({ 'Merge-SHA': MERGE_SHA }), {
    phase: 'final',
    expectedMergeSha: 'fedcba9876543210fedcba9876543210fedcba98',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join('\n'), /does not match GitHub merge_commit_sha/);
});

test('PR event checker exits non-zero when a required field is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-task-acceptance-'));
  const eventPath = path.join(dir, 'event.json');
  const incompleteBody = body()
    .split('\n')
    .filter((line) => !line.startsWith('Tests:'))
    .join('\n');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { body: incompleteBody, merged: false } }));

  const run = spawnSync(process.execPath, ['scripts/check-task-acceptance.js'], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Tests must appear exactly once/);
});

test('final PR event checker rejects pending merge SHA and accepts exact merge SHA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-task-acceptance-final-'));
  const eventPath = path.join(dir, 'event.json');

  fs.writeFileSync(eventPath, JSON.stringify({
    pull_request: { body: body(), merged: true, merge_commit_sha: MERGE_SHA },
  }));
  const rejected = spawnSync(process.execPath, ['scripts/check-task-acceptance.js'], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);

  fs.writeFileSync(eventPath, JSON.stringify({
    pull_request: { body: body({ 'Merge-SHA': MERGE_SHA }), merged: true, merge_commit_sha: MERGE_SHA },
  }));
  const accepted = spawnSync(process.execPath, ['scripts/check-task-acceptance.js'], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: 'utf8',
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /task acceptance accepted \(final\): NH-018/);
});

test('parser exposes exactly one value per required field for canonical body', () => {
  const parsed = parseTaskAcceptance(body());
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(Object.keys(parsed.values), REQUIRED_TASK_ACCEPTANCE_FIELDS);
});
