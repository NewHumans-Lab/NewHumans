import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SANDBOX_CONTRACT_VERSION,
  assertSandboxExecutionRequest,
  assertSandboxRelativePath,
  classifySandboxExit,
} from '../../src/services/sandbox_contract.js';

function request(overrides = {}) {
  const base = {
    contract_version: SANDBOX_CONTRACT_VERSION,
    kind: 'request',
    execution_id: '8a454c76-9c2b-4a85-a9cf-ae14486ec788',
    command: {
      executable: 'node',
      argv: ['job.js'],
      cwd: '.',
    },
    limits: {
      cpu_millis: 1_000,
      memory_bytes: 64 * 1024 * 1024,
      wall_time_ms: 2_000,
      disk_bytes: 16 * 1024 * 1024,
    },
    network: {
      mode: 'DENY_ALL',
      allow_hosts: [],
    },
    artifacts: [
      {
        path: 'artifacts/result.json',
        required: true,
        max_bytes: 1024 * 1024,
        media_type: 'application/json',
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    command: { ...base.command, ...(overrides.command || {}) },
    limits: { ...base.limits, ...(overrides.limits || {}) },
    network: { ...base.network, ...(overrides.network || {}) },
    artifacts: overrides.artifacts || base.artifacts,
  };
}

test('accepts an explicit argv command and bounded execution request', () => {
  assert.equal(assertSandboxExecutionRequest(request()).kind, 'request');
});

test('classifies timeout without claiming an implementation mechanism', () => {
  const exit = classifySandboxExit(request(), {
    wall_time_ms: 2_001,
    cpu_millis: 500,
    memory_peak_bytes: 1024,
    disk_bytes: 0,
  });
  assert.deepEqual(exit, { reason: 'TIME_LIMIT_EXCEEDED', code: null, signal: null });
});

test('classifies peak memory above the request limit', () => {
  const req = request({ limits: { memory_bytes: 1024 } });
  const exit = classifySandboxExit(req, { memory_peak_bytes: 1025 });
  assert.equal(exit.reason, 'MEMORY_LIMIT_EXCEEDED');
});

test('classifies a denied network attempt when network is forbidden', () => {
  const req = request({ network: { mode: 'DENY_ALL', allow_hosts: [] } });
  const exit = classifySandboxExit(req, { network_denied: true });
  assert.equal(exit.reason, 'NETWORK_DENIED');
});

test('rejects DENY_ALL requests that smuggle an allowlist', () => {
  const req = request({ network: { mode: 'DENY_ALL', allow_hosts: ['example.com'] } });
  assert.throws(() => assertSandboxExecutionRequest(req), /empty allow_hosts/);
});

test('rejects absolute and escaping artifact paths', () => {
  for (const candidate of ['/etc/passwd', '../secret', 'artifacts/../../secret', 'C:/temp/secret']) {
    assert.throws(() => assertSandboxRelativePath(candidate), /sandbox path/);
  }
});

test('rejects executable paths that escape the workspace', () => {
  const req = request({ command: { executable: '../bin/tool' } });
  assert.throws(() => assertSandboxExecutionRequest(req), /sandbox path/);
});

test('rejects non-canonical Windows separators in artifact paths', () => {
  assert.throws(() => assertSandboxRelativePath('artifacts\\result.json'), /POSIX separators/);
});
