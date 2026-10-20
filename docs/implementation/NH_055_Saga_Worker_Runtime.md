# NH-055 Saga worker runtime

Status: implementation added; external Knowledge Ball adapter configuration remains deployment-owned.

## Start command

Run `npm run start:saga-worker` as a separate process from the HTTP API. The worker requires the same validated database and Knowledge Ball environment as the rest of the service, and it refuses to start unless `KB_PROVIDER=knowledge-ball`. It never selects the local Economy implementation.

Set `NH_SAGA_WORKER_ADAPTER_MODULE` to an absolute or working-directory-relative path to a trusted JavaScript module. The module must export either:

- `economyPort`: an NH-005 EconomyPort object with `escrow(request)`; and
- `lookupOperationByIdempotencyKey({ worldId, operationKey, payloadDigest })`: an authoritative KB lookup that returns `{ state: 'FOUND', result }`, `{ state: 'NOT_FOUND' }`, or `{ state: 'UNKNOWN' }`.

Alternatively, export `createSagaWorkerAdapter({ pool, env })` returning those two properties. A FOUND result must include the stable `operation_key`, the original `payload_digest`, and the authoritative `status` / `result_ref` fields expected by the Saga Inbox. A NOT_FOUND result must be authoritative for that exact idempotency key; only then can the original operation key be retried.

Optional tuning variables: `NH_SAGA_WORKER_ID`, `NH_SAGA_POLL_INTERVAL_MS`, `NH_SAGA_IDLE_INTERVAL_MS`, `NH_SAGA_RETRY_AFTER_MS`, and `NH_SAGA_MAX_ATTEMPTS`.

## Runtime safety

- The worker runs as a separate process, with graceful SIGINT/SIGTERM shutdown.
- Outbox claim/dispatch and Saga result persistence use the durable database helpers; HTTP is never called inside the transaction that claims the row.
- The logical funds idempotency key remains unchanged across retries; each transport dispatch receives a fresh request ID.
- Ambiguous outcomes are reconciled before replay; an unavailable reconciliation service keeps the Saga quarantined.
- The Knowledge Ball adapter module is intentionally deployment-supplied. This repository does not assert that a production KB endpoint or its lookup API has been configured or verified.
