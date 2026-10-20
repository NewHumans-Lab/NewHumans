import test from 'node:test';
import assert from 'node:assert/strict';
import { runSagaWorkerLoop } from '../../src/services/cross_product_saga_worker_runtime.js';

const valid = {
  workerId: 'worker-unit',
  economyPort: { escrow: async () => { throw new Error('must not be called'); } },
  lookupOperationByIdempotencyKey: async () => { throw new Error('must not be called'); },
};

test('worker loop exits cleanly when its AbortSignal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.doesNotReject(() => runSagaWorkerLoop({}, { ...valid, signal: controller.signal }));
});

test('worker loop refuses to start without authoritative idempotency reconciliation', async () => {
  await assert.rejects(
    () => runSagaWorkerLoop({}, { workerId: valid.workerId, economyPort: valid.economyPort }),
    (error) => error.code === 'KB_ECONOMY_PORT_UNAVAILABLE',
  );
});

test('worker loop validates polling intervals before entering the loop', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runSagaWorkerLoop({}, { ...valid, signal: controller.signal, pollIntervalMs: 50 }),
    (error) => error.code === 'INVALID_SAGA_WORKER_CONFIG',
  );
});
