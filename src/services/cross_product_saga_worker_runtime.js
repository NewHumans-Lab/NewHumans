import { dispatchSagaOutboxOnce, reconcileSagaOnce } from './cross_product_saga_worker.js';

function positiveInterval(value, fallback, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    const error = new Error(field + ' must be an integer between 100 and 300000 milliseconds');
    error.code = 'INVALID_SAGA_WORKER_CONFIG';
    throw error;
  }
  return value;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Execute one scheduler tick; each DB claim is independently transactional. */
export async function runSagaWorkerTick(pool, {
  workerId,
  economyPort,
  lookupOperationByIdempotencyKey,
  leaseMs = 30_000,
  retryAfterMs = 5_000,
  maxAttempts = 5,
} = {}) {
  const reconciliation = typeof lookupOperationByIdempotencyKey === 'function'
    ? await reconcileSagaOnce(pool, { workerId, lookupOperationByIdempotencyKey, leaseMs, retryAfterMs })
    : { claimed: false, outcome: 'RECONCILIATION_NOT_CONFIGURED' };
  const dispatch = await dispatchSagaOutboxOnce(pool, {
    workerId, economyPort, leaseMs, maxAttempts, retryAfterMs,
  });
  return { reconciliation, dispatch };
}

/**
 * Long-running worker loop. It deliberately does not construct a KB client or
 * select a local fallback; callers must inject the authoritative EconomyPort.
 */
export async function runSagaWorkerLoop(pool, {
  workerId,
  economyPort,
  lookupOperationByIdempotencyKey,
  pollIntervalMs = 1_000,
  idleIntervalMs = 2_000,
  leaseMs = 30_000,
  retryAfterMs = 5_000,
  maxAttempts = 5,
  signal,
  onTick = () => {},
  onError = () => {},
} = {}) {
  if (typeof workerId !== 'string' || !workerId.trim()) {
    const error = new Error('workerId is required');
    error.code = 'INVALID_SAGA_WORKER_CONFIG';
    throw error;
  }
  if (!economyPort || typeof economyPort.escrow !== 'function') {
    const error = new Error('authoritative Knowledge Ball EconomyPort is required');
    error.code = 'KB_ECONOMY_PORT_UNAVAILABLE';
    throw error;
  }
  pollIntervalMs = positiveInterval(pollIntervalMs, 1_000, 'pollIntervalMs');
  idleIntervalMs = positiveInterval(idleIntervalMs, 2_000, 'idleIntervalMs');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    const error = new Error('maxAttempts must be an integer from 1 to 100');
    error.code = 'INVALID_SAGA_WORKER_CONFIG';
    throw error;
  }

  while (!signal?.aborted) {
    let delay = pollIntervalMs;
    try {
      const result = await runSagaWorkerTick(pool, {
        workerId, economyPort, lookupOperationByIdempotencyKey,
        leaseMs, retryAfterMs, maxAttempts,
      });
      onTick(result);
      if (result.dispatch.outcome === 'IDLE' && result.reconciliation.outcome === 'IDLE') delay = idleIntervalMs;
    } catch (error) {
      // A failed tick must not kill the process or bypass durable retry state.
      onError({ code: error?.code ?? 'SAGA_WORKER_TICK_FAILED', message: error?.message ?? 'unknown worker error' });
      delay = idleIntervalMs;
    }
    await sleep(delay, signal);
  }
}
