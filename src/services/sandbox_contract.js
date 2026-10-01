import path from 'node:path';

export const SANDBOX_CONTRACT_VERSION = 'nh.sandbox.v1';

export const SANDBOX_EXIT_REASONS = Object.freeze([
  'COMPLETED',
  'NONZERO_EXIT',
  'SIGNALLED',
  'CPU_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'TIME_LIMIT_EXCEEDED',
  'DISK_LIMIT_EXCEEDED',
  'NETWORK_DENIED',
  'INVALID_REQUEST',
  'START_FAILED',
  'EXECUTOR_ERROR',
]);

const LIMIT_FIELDS = Object.freeze([
  'cpu_millis',
  'memory_bytes',
  'wall_time_ms',
  'disk_bytes',
]);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_SANDBOX_CONTRACT';
  error.status = 400;
  return error;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative safe integer`);
  }
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object`);
  }
}

function assertString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw invalid(`${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw invalid(`${field} contains a forbidden control character`);
  }
}

export function assertSandboxRelativePath(value, { allowDot = false } = {}) {
  assertString(value, 'sandbox path');
  if (value.includes('\\')) throw invalid('sandbox paths must use POSIX separators');
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw invalid('sandbox paths must be relative to the workspace root');
  }
  if (allowDot && value === '.') return value;
  if (value === '.') throw invalid('artifact path cannot be the workspace root');

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw invalid('sandbox path must be canonical and cannot contain dot segments');
  }
  if (path.posix.normalize(value) !== value) {
    throw invalid('sandbox path must be canonical');
  }
  return value;
}

function assertExactHost(value, field) {
  assertString(value, field);
  if (value !== value.toLowerCase()) throw invalid(`${field} must be lowercase`);
  if (value.includes('://') || /[:/?#@\s]/.test(value)) {
    throw invalid(`${field} must be an exact host, not a URL`);
  }
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw invalid(`${field} is not a canonical host`);
  }
}

export function assertSandboxExecutionRequest(request) {
  assertPlainObject(request, 'request');
  if (request.contract_version !== SANDBOX_CONTRACT_VERSION) {
    throw invalid(`contract_version must be ${SANDBOX_CONTRACT_VERSION}`);
  }
  if (request.kind !== 'request') throw invalid('kind must be request');
  assertString(request.execution_id, 'execution_id');

  assertPlainObject(request.command, 'command');
  assertString(request.command.executable, 'command.executable');
  if (/\s/.test(request.command.executable)) {
    throw invalid('command.executable must be a single executable token or relative path');
  }
  if (request.command.executable.includes('/')) assertSandboxRelativePath(request.command.executable);
  if (!Array.isArray(request.command.argv)) throw invalid('command.argv must be an array');
  for (const [index, arg] of request.command.argv.entries()) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw invalid(`command.argv[${index}] must be a NUL-free string`);
    }
  }
  assertSandboxRelativePath(request.command.cwd, { allowDot: true });

  assertPlainObject(request.limits, 'limits');
  for (const field of LIMIT_FIELDS) assertPositiveInteger(request.limits[field], `limits.${field}`);

  assertPlainObject(request.network, 'network');
  if (!['DENY_ALL', 'ALLOWLIST'].includes(request.network.mode)) {
    throw invalid('network.mode must be DENY_ALL or ALLOWLIST');
  }
  if (!Array.isArray(request.network.allow_hosts)) {
    throw invalid('network.allow_hosts must be an array');
  }
  const hosts = new Set();
  for (const [index, host] of request.network.allow_hosts.entries()) {
    assertExactHost(host, `network.allow_hosts[${index}]`);
    if (hosts.has(host)) throw invalid('network.allow_hosts must not contain duplicates');
    hosts.add(host);
  }
  if (request.network.mode === 'DENY_ALL' && request.network.allow_hosts.length !== 0) {
    throw invalid('DENY_ALL requires an empty allow_hosts list');
  }
  if (request.network.mode === 'ALLOWLIST' && request.network.allow_hosts.length === 0) {
    throw invalid('ALLOWLIST requires at least one exact host');
  }

  if (!Array.isArray(request.artifacts)) throw invalid('artifacts must be an array');
  const artifactPaths = new Set();
  for (const [index, artifact] of request.artifacts.entries()) {
    assertPlainObject(artifact, `artifacts[${index}]`);
    assertSandboxRelativePath(artifact.path);
    if (artifactPaths.has(artifact.path)) throw invalid('artifact paths must be unique');
    artifactPaths.add(artifact.path);
    if (typeof artifact.required !== 'boolean') {
      throw invalid(`artifacts[${index}].required must be boolean`);
    }
    assertPositiveInteger(artifact.max_bytes, `artifacts[${index}].max_bytes`);
    if (artifact.max_bytes > request.limits.disk_bytes) {
      throw invalid(`artifacts[${index}].max_bytes cannot exceed limits.disk_bytes`);
    }
    if (artifact.media_type !== undefined) assertString(artifact.media_type, `artifacts[${index}].media_type`);
  }

  return request;
}

export function assertSandboxExecutionResult(result, request) {
  assertPlainObject(result, 'result');
  if (result.contract_version !== SANDBOX_CONTRACT_VERSION) {
    throw invalid(`contract_version must be ${SANDBOX_CONTRACT_VERSION}`);
  }
  if (result.kind !== 'result') throw invalid('kind must be result');
  assertString(result.execution_id, 'execution_id');
  if (request && result.execution_id !== request.execution_id) {
    throw invalid('result.execution_id must match request.execution_id');
  }

  assertPlainObject(result.exit, 'exit');
  if (!SANDBOX_EXIT_REASONS.includes(result.exit.reason)) {
    throw invalid('exit.reason is not part of the sandbox exit contract');
  }
  if (result.exit.code !== null && !Number.isInteger(result.exit.code)) {
    throw invalid('exit.code must be an integer or null');
  }
  if (result.exit.signal !== null && typeof result.exit.signal !== 'string') {
    throw invalid('exit.signal must be a string or null');
  }

  assertPlainObject(result.usage, 'usage');
  for (const field of ['cpu_millis', 'memory_peak_bytes', 'wall_time_ms', 'disk_bytes', 'network_requests']) {
    assertNonNegativeInteger(result.usage[field], `usage.${field}`);
  }

  if (!Array.isArray(result.artifacts)) throw invalid('result.artifacts must be an array');
  const declared = request ? new Map(request.artifacts.map((artifact) => [artifact.path, artifact])) : null;
  const seen = new Set();
  for (const [index, artifact] of result.artifacts.entries()) {
    assertPlainObject(artifact, `result.artifacts[${index}]`);
    assertSandboxRelativePath(artifact.path);
    if (seen.has(artifact.path)) throw invalid('result artifact paths must be unique');
    seen.add(artifact.path);
    assertNonNegativeInteger(artifact.size_bytes, `result.artifacts[${index}].size_bytes`);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw invalid(`result.artifacts[${index}].sha256 must be lowercase sha256 hex`);
    }
    if (artifact.media_type !== undefined) assertString(artifact.media_type, `result.artifacts[${index}].media_type`);
    if (declared) {
      const policy = declared.get(artifact.path);
      if (!policy) throw invalid(`result artifact ${artifact.path} was not declared by the request`);
      if (artifact.size_bytes > policy.max_bytes) {
        throw invalid(`result artifact ${artifact.path} exceeds its declared max_bytes`);
      }
    }
  }

  if (request) {
    for (const artifact of request.artifacts) {
      if (artifact.required && !seen.has(artifact.path)) {
        throw invalid(`required artifact ${artifact.path} is missing from result`);
      }
    }
  }
  return result;
}

export function classifySandboxExit(request, observation = {}) {
  assertSandboxExecutionRequest(request);
  const {
    timed_out = false,
    wall_time_ms = 0,
    cpu_millis = 0,
    memory_peak_bytes = 0,
    disk_bytes = 0,
    network_denied = false,
    start_failed = false,
    executor_error = false,
    exit_code = 0,
    signal = null,
  } = observation;

  if (executor_error) return { reason: 'EXECUTOR_ERROR', code: null, signal: null };
  if (start_failed) return { reason: 'START_FAILED', code: null, signal: null };
  if (timed_out || wall_time_ms > request.limits.wall_time_ms) {
    return { reason: 'TIME_LIMIT_EXCEEDED', code: null, signal };
  }
  if (memory_peak_bytes > request.limits.memory_bytes) {
    return { reason: 'MEMORY_LIMIT_EXCEEDED', code: null, signal };
  }
  if (disk_bytes > request.limits.disk_bytes) {
    return { reason: 'DISK_LIMIT_EXCEEDED', code: null, signal };
  }
  if (cpu_millis > request.limits.cpu_millis) {
    return { reason: 'CPU_LIMIT_EXCEEDED', code: null, signal };
  }
  if (network_denied) return { reason: 'NETWORK_DENIED', code: null, signal };
  if (signal) return { reason: 'SIGNALLED', code: null, signal };
  if (exit_code === 0) return { reason: 'COMPLETED', code: 0, signal: null };
  return { reason: 'NONZERO_EXIT', code: exit_code, signal: null };
}
