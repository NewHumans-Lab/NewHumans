import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPool } from '../src/db.js';
import { runSagaWorkerLoop } from '../src/services/cross_product_saga_worker_runtime.js';
import { validateEnvironment } from '../src/shared/environment.js';

const environment = validateEnvironment(process.env);
if (environment.kbProvider !== 'knowledge-ball') {
  throw Object.assign(new Error('Saga worker requires KB_PROVIDER=knowledge-ball; local economy fallback is forbidden'), { code: 'KB_AUTHORITY_REQUIRED' });
}
const modulePath = process.env.NH_SAGA_WORKER_ADAPTER_MODULE;
if (typeof modulePath !== 'string' || !modulePath.trim()) {
  throw Object.assign(new Error('NH_SAGA_WORKER_ADAPTER_MODULE must point to the configured Knowledge Ball adapter module'), { code: 'SAGA_WORKER_ADAPTER_NOT_CONFIGURED' });
}

const adapterModule = await import(pathToFileURL(path.resolve(modulePath)).href);
const pool = createPool(environment.databaseUrl);
const workerId = process.env.NH_SAGA_WORKER_ID?.trim() || os.hostname() + ':' + process.pid;
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const adapter = typeof adapterModule.createSagaWorkerAdapter === 'function'
    ? await adapterModule.createSagaWorkerAdapter({ pool, env: process.env })
    : adapterModule;
  const economyPort = adapter?.economyPort;
  const lookupOperationByIdempotencyKey = adapter?.lookupOperationByIdempotencyKey;
  if (!economyPort || typeof economyPort.escrow !== 'function' || typeof lookupOperationByIdempotencyKey !== 'function') {
    throw Object.assign(new Error('adapter must export economyPort.escrow and lookupOperationByIdempotencyKey'), { code: 'SAGA_WORKER_ADAPTER_INVALID' });
  }
  await runSagaWorkerLoop(pool, {
    workerId,
    economyPort,
    lookupOperationByIdempotencyKey,
    pollIntervalMs: Number(process.env.NH_SAGA_POLL_INTERVAL_MS || 1000),
    idleIntervalMs: Number(process.env.NH_SAGA_IDLE_INTERVAL_MS || 2000),
    retryAfterMs: Number(process.env.NH_SAGA_RETRY_AFTER_MS || 5000),
    maxAttempts: Number(process.env.NH_SAGA_MAX_ATTEMPTS || 5),
    signal: controller.signal,
    onTick: (result) => process.stdout.write(JSON.stringify({ event: 'saga_worker_tick', workerId, ...result }) + '\\n'),
    onError: (error) => process.stderr.write(JSON.stringify({ event: 'saga_worker_error', workerId, ...error }) + '\\n'),
  });
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await pool.end();
}
