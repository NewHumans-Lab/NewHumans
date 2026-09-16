import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-replacement-audit-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { body } }));
  const out = spawnSync(process.execPath, ['scripts/check-replacement-audit.js'], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('replacement audit accepts explicit NOT_APPLICABLE invocation', () => {
  const out = run('Replacement-Audit: NOT_APPLICABLE');
  assert.equal(out.status, 0, out.stderr);
});

test('replacement audit rejects a PR that omits the command', () => {
  const out = run('no audit declaration');
  assert.notEqual(out.status, 0);
});

test('applicable replacement requires concrete cleanup and regression evidence', () => {
  const missing = run('Replacement-Audit: APPLICABLE\nSuperseded-Paths: old/api\nCleanup-Evidence: N/A\nRegression-Evidence: tests passed');
  assert.notEqual(missing.status, 0);

  const complete = run('Replacement-Audit: APPLICABLE\nSuperseded-Paths: old/api and legacy worker\nCleanup-Evidence: removed handlers and repository-wide references\nRegression-Evidence: old and new regression suites passed');
  assert.equal(complete.status, 0, complete.stderr);
});

test('replacement audit rejects ambiguous multiple declarations', () => {
  const out = run('Replacement-Audit: NOT_APPLICABLE\nReplacement-Audit: APPLICABLE\nSuperseded-Paths: x\nCleanup-Evidence: y\nRegression-Evidence: z');
  assert.notEqual(out.status, 0);
});
