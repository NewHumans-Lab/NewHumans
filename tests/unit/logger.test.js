import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLogRecord,
  createLogger,
  isSensitiveLogField,
  redactLogFields,
  serializeLogRecord,
} from '../../src/shared/logger.js';

const fixedNow = new Date('2026-10-01T06:00:00.000Z');

test('structured logger serializes canonical correlation identifiers', () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line), now: () => fixedNow });
  const record = logger.info('action accepted', {
    worldId: 'world-1',
    action_id: 'action-1',
    executionId: 'execution-1',
    correlation_id: 'corr-1',
    taskId: 'task-1',
    result: 'ok',
  });

  assert.deepEqual(record, {
    timestamp: '2026-10-01T06:00:00.000Z',
    level: 'info',
    message: 'action accepted',
    world_id: 'world-1',
    action_id: 'action-1',
    execution_id: 'execution-1',
    correlation_id: 'corr-1',
    task_id: 'task-1',
    result: 'ok',
  });
  assert.deepEqual(JSON.parse(lines[0]), record);
  assert.throws(
    () => logger.info('conflict', { worldId: 'world-1', world_id: 'world-2' }),
    (error) => error.code === 'INVALID_LOG_CONTEXT',
  );
});

test('redaction removes secret-bearing values recursively but preserves credential identifiers', () => {
  const input = {
    token: 'raw-token',
    password: 'raw-password',
    credential_secret: 'raw-credential-secret',
    credential_id: 'cred-123',
    nested: {
      accessToken: 'nested-token',
      api_key: 'nested-api-key',
      credentials: { username: 'user', password: 'nested-password' },
    },
  };
  const redacted = redactLogFields(input);
  const serialized = JSON.stringify(redacted);

  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.credential_secret, '[REDACTED]');
  assert.equal(redacted.credential_id, 'cred-123');
  assert.equal(redacted.nested.accessToken, '[REDACTED]');
  assert.equal(redacted.nested.api_key, '[REDACTED]');
  assert.equal(redacted.nested.credentials, '[REDACTED]');
  assert.equal(serialized.includes('raw-token'), false);
  assert.equal(serialized.includes('raw-password'), false);
  assert.equal(serialized.includes('raw-credential-secret'), false);
  assert.equal(serialized.includes('nested-api-key'), false);
  assert.equal(isSensitiveLogField('credential_id'), false);
  assert.equal(isSensitiveLogField('clientSecret'), true);
});

test('BigInt values serialize as decimal strings', () => {
  const record = buildLogRecord({
    level: 'info',
    message: 'energy amount',
    fields: { amount_micro_e: 900719925474099312345n },
    now: fixedNow,
  });
  const parsed = JSON.parse(serializeLogRecord(record));
  assert.equal(parsed.amount_micro_e, '900719925474099312345');
});

test('Error values serialize with useful diagnostics and redact custom secret fields', () => {
  const cause = new Error('database unavailable');
  const error = new Error('request failed', { cause });
  error.code = 'UPSTREAM_FAILURE';
  error.status = 502;
  error.token = 'error-token';

  const parsed = JSON.parse(serializeLogRecord(buildLogRecord({
    level: 'error',
    message: 'gateway failure',
    fields: { error },
    now: fixedNow,
  })));

  assert.equal(parsed.error.name, 'Error');
  assert.equal(parsed.error.message, 'request failed');
  assert.match(parsed.error.stack, /request failed/);
  assert.equal(parsed.error.code, 'UPSTREAM_FAILURE');
  assert.equal(parsed.error.status, 502);
  assert.equal(parsed.error.token, '[REDACTED]');
  assert.equal(parsed.error.cause.message, 'database unavailable');
  assert.equal(JSON.stringify(parsed).includes('error-token'), false);
});

test('child logger carries structured base context without mutating parent', () => {
  const lines = [];
  const root = createLogger({ write: (line) => lines.push(line), now: () => fixedNow, base: { worldId: 'world-1' } });
  const child = root.child({ correlationId: 'corr-1' });
  child.warn('task delayed', { taskId: 'task-1' });
  root.info('world healthy');

  const childRecord = JSON.parse(lines[0]);
  const rootRecord = JSON.parse(lines[1]);
  assert.equal(childRecord.world_id, 'world-1');
  assert.equal(childRecord.correlation_id, 'corr-1');
  assert.equal(childRecord.task_id, 'task-1');
  assert.equal('correlation_id' in rootRecord, false);
});
