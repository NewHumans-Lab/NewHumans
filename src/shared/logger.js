const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

export const LOG_ID_FIELDS = Object.freeze([
  'world_id',
  'action_id',
  'execution_id',
  'correlation_id',
  'task_id',
]);

const ID_ALIASES = Object.freeze({
  world_id: ['world_id', 'worldId'],
  action_id: ['action_id', 'actionId'],
  execution_id: ['execution_id', 'executionId'],
  correlation_id: ['correlation_id', 'correlationId'],
  task_id: ['task_id', 'taskId'],
});

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SENSITIVE_EXACT = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'authorization',
  'proxy_authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'credential',
  'credentials',
  'credential_secret',
  'api_key',
  'apikey',
  'cookie',
  'set_cookie',
  'private_key',
]);

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function isSensitiveLogField(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (normalized === 'credential_id' || normalized.endsWith('_credential_id')) return false;
  const segments = normalized.split('_');
  return SENSITIVE_EXACT.has(normalized)
    || segments.includes('token')
    || segments.includes('password')
    || segments.includes('passwd')
    || segments.includes('pwd')
    || segments.includes('secret')
    || normalized.endsWith('_api_key')
    || normalized.endsWith('_private_key');
}

function sanitizeError(error, seen) {
  const output = {
    name: error.name,
    message: error.message,
  };
  if (typeof error.stack === 'string') output.stack = error.stack;
  if ('cause' in error && error.cause !== undefined) output.cause = sanitizeValue(error.cause, seen);
  for (const key of Object.keys(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
    output[key] = isSensitiveLogField(key) ? REDACTED : sanitizeValue(error[key], seen);
  }
  return output;
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (value instanceof Error) return sanitizeError(value, seen);
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      const sanitized = isSensitiveLogField(key) ? REDACTED : sanitizeValue(item, seen);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function redactLogFields(value) {
  return sanitizeValue(value);
}

function invalidContext(message) {
  const error = new Error(message);
  error.code = 'INVALID_LOG_CONTEXT';
  return error;
}

function canonicalizeIds(fields) {
  const ids = {};
  const consumed = new Set();
  for (const [canonical, aliases] of Object.entries(ID_ALIASES)) {
    const present = aliases.filter((alias) => fields[alias] !== undefined && fields[alias] !== null);
    if (present.length === 0) continue;
    const values = present.map((alias) => fields[alias]);
    if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw invalidContext(`${canonical} must be a non-empty string`);
    }
    if (new Set(values).size > 1) throw invalidContext(`conflicting aliases for ${canonical}`);
    ids[canonical] = values[0];
    for (const alias of present) consumed.add(alias);
  }
  return { ids, consumed };
}

function toTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalidContext('logger clock returned an invalid timestamp');
  return date.toISOString();
}

export function buildLogRecord({ level, message, fields = {}, now = new Date() }) {
  if (!LEVELS.has(level)) throw invalidContext(`unsupported log level: ${level}`);
  if (typeof message !== 'string' || message.length === 0) throw invalidContext('log message must be a non-empty string');
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw invalidContext('log fields must be an object');

  const { ids, consumed } = canonicalizeIds(fields);
  const extras = {};
  for (const [key, value] of Object.entries(fields)) {
    if (consumed.has(key) || key === 'timestamp' || key === 'level' || key === 'message') continue;
    const sanitized = isSensitiveLogField(key) ? REDACTED : sanitizeValue(value);
    if (sanitized !== undefined) extras[key] = sanitized;
  }

  return {
    timestamp: toTimestamp(now),
    level,
    message,
    ...ids,
    ...extras,
  };
}

export function serializeLogRecord(record) {
  return JSON.stringify(redactLogFields(record));
}

export function createLogger({ write = (line) => process.stdout.write(`${line}\n`), now = () => new Date(), base = {} } = {}) {
  if (typeof write !== 'function') throw invalidContext('logger write sink must be a function');
  if (typeof now !== 'function') throw invalidContext('logger clock must be a function');
  if (base === null || typeof base !== 'object' || Array.isArray(base)) throw invalidContext('logger base context must be an object');

  const emit = (level, message, fields = {}) => {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw invalidContext('log fields must be an object');
    const record = buildLogRecord({ level, message, fields: { ...base, ...fields }, now: now() });
    write(serializeLogRecord(record));
    return record;
  };

  return Object.freeze({
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields = {}) => createLogger({ write, now, base: { ...base, ...fields } }),
  });
}
