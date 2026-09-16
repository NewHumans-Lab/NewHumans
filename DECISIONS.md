# Architecture decisions

## ADR-001 — V3 is the P0/P1 contract baseline
Status: Accepted · 2026-09-16

Implementation uses `nh.v3.0`. Core semantic changes require a new protocol version; configuration-only changes must not silently redefine persisted meaning.

## ADR-002 — Modular monolith before microservices
Status: Accepted

P0/P1 uses one Node.js service and one PostgreSQL database with module-owned schemas. Cross-domain invariants remain transactional. Module ownership is preserved in schema and service boundaries without introducing distributed transactions.

## ADR-003 — microE is the only persisted Energy amount
Status: Accepted

`1 E = 1,000,000 microE`. Database amounts are `bigint`; JSON command amounts are decimal integer strings. Floating point Energy is rejected.

## ADR-004 — Ledger writes are balanced journals
Status: Accepted

Every monetary journal must sum to zero. Entity wallet balances are updated by database posting triggers; ordinary wallets cannot become negative. Reservations reduce available balance but are not consumption.

## ADR-005 — Idempotency belongs to actions, not UI retries
Status: Accepted

All state-changing API commands require `Idempotency-Key`. `(world_id, actor_entity_id, idempotency_key)` is unique. Replaying the same payload returns the original result; reusing the key for a different command is a conflict.

## ADR-006 — P0/P1 does not implement life runtime
Status: Accepted

`economy.activity_subjects.first_activated_at` records only the accounting fact required to enforce first-activation rules. ACTIVE/DORMANT runtime state, leases, checkpoints, goals and model routing remain M02 responsibilities and are deliberately absent.

## ADR-007 — Development bootstrap is never production authentication
Status: Accepted

`POST /api/v1/dev/bootstrap` is available only when `LOCAL_DEV_BOOTSTRAP=true` and `NODE_ENV != production`. Production identity verification is not simulated or claimed by the executable foundation.

## ADR-008 — World isolation is a database invariant
Status: Accepted · 2026-09-16

Any table that stores both `world_id` and an Entity reference uses a composite foreign key to `(world_id, entity_id)`. Application checks remain useful error handling, but they are not the final authority for cross-world integrity. Ledger postings, which inherit world from their journal, use a database trigger to reject an Entity from another world.

## ADR-009 — Energy journals are sealed append-only records
Status: Accepted · 2026-09-16

Committed `economy.journals` and `economy.postings` cannot be updated or deleted. A journal records its expected posting count; deferred database constraints require the final count to match and the signed sum to equal zero. Later balanced postings cannot be appended to an already committed journal. Corrections use a new `REVERSAL` journal referencing the original.

## ADR-010 — The canonical command contract is snake_case `nh.v3.0`
Status: Accepted · 2026-09-16

`schemas/command-envelope.schema.json` follows the authoritative Shared Contracts document. Authenticated actor identity and current world are trusted request context; neither is accepted from the command envelope or business payload.

## ADR-011 — External model I/O never holds a database transaction open
Status: Accepted · 2026-09-16

M06 prepares and records an execution in a short transaction, commits, performs provider network I/O without database locks, then opens a new short transaction to record the result and settle M05. This prevents model latency from turning wallet/action rows into long-held locks.

## ADR-012 — Ambiguous external outcomes preserve budget and prohibit automatic replay
Status: Accepted · 2026-09-16

A timeout or other ambiguous post-dispatch network failure becomes `OUTCOME_UNKNOWN`. M06 retains the active reservation and creates reconciliation work. Reusing the same action idempotency key returns the existing unknown outcome instead of sending a second provider request.

## ADR-013 — M06 does not own money and BYOK is not double billed
Status: Accepted · 2026-09-16

M06 records measured usage; M05 remains the only authority that turns a platform-paid reservation into a `RESOURCE_CHARGE` journal. BYOK usage is marked `external_billing=true` with zero NewHumans model charge. Activity-day fees remain independent.

## ADR-014 — Connector secrets are references, not gateway business data
Status: Accepted · 2026-09-16

Gateway connector rows may store the name of a server-side environment credential reference. Secret values are resolved only at dispatch time and never enter gateway tables, Action/Event payloads, browser configuration, usage receipts or returned execution results. A production credential vault may replace environment resolution later without changing the business contract.

## ADR-015 — Every provider attempt revalidates current execution eligibility atomically
Status: Accepted · 2026-09-16

Initial authorization is not a reusable license for later sends. Immediately before every provider attempt, including retries, M06 rechecks the current actor, current UTC billing date, charged activity fee, positive available Energy, descriptor/connector availability and platform reservation. P1.4 additionally enforces the quote/reservation link and quote expiry at provider-request insertion for quote-backed executions. Those checks occur before provider network I/O.

## ADR-016 — Trustworthy measured usage is settled even when the result payload is unusable
Status: Accepted · 2026-09-16

Provider execution outcome and local result usability are separate facts. If a provider response contains trustworthy measured usage but the output is malformed or violates a requested result limit, M06 records the usage and asks M05 to settle the exact known charge, then marks the execution `FAILED`. `OUTCOME_UNKNOWN` is reserved for cases where execution/usage is materially uncertain; an unusable result does not erase a known cost.

## ADR-017 — World is trusted context, not a command field
Status: Accepted · 2026-09-16

The canonical `nh.v3.0` command envelope no longer contains `world_id`. The current world is bound by trusted server context together with the authenticated actor. The development adapter represents that context with `x-nh-world-id` and is production-blocked, exactly like the development actor header. Client payloads containing `worldId` or `world_id` are rejected. Internal Action hashing keeps the trusted world in the persisted payload shape only to preserve replay compatibility with pre-P1.4 actions.

## ADR-018 — Platform-paid M06 execution is quote-backed
Status: Accepted · 2026-09-16

A new public platform-paid inference follows `M05 quote → M05 reservation → M06 execution → M06 usage receipt → M05 settlement`. The quote snapshots resource scope, descriptor version/rates, limits, maximum cost and expiry. A reservation references exactly one quote and the database binds the execution to that reservation's quote.

Existing P1.3 internal calls remain grandfathered so migration 005 does not reinterpret or break previously valid direct service usage. The P1.4 HTTP/service surface requires the explicit quote-backed path. BYOK does not create a platform model-cost quote/reservation because the external provider cost is not paid from NewHumans Energy.

## ADR-019 — `max_retries` excludes the initial attempt
Status: Accepted · 2026-09-16

`max_retries` is an integer from 0 through 3. It counts retries after the initial attempt, so `max_retries=3` permits at most four provider attempts total. The legacy `max_attempts` database/input path is retained as a compatibility field for P1.2/P1.3 code and synchronized as `max_attempts=max_retries+1`; new machine/HTTP surfaces use `max_retries`.

## ADR-020 — Cancellation is truthful about dispatch state
Status: Accepted · 2026-09-16

`gateway.cancel` may mark a `PROPOSED` execution `CANCELLED` and release its quote-backed reservation because no provider request has left the system. A `DISPATCHED` execution is not labelled cancelled merely because cancellation was requested; until a provider-specific cancellation protocol is implemented, the API returns that cancellation was not accepted and preserves the real execution state. Already terminal executions replay their terminal state.

## ADR-021 — Accepted billing authority is immutable evidence
Status: Accepted · 2026-09-16

A versioned gateway descriptor is an execution and pricing contract. Its model reference, limits, retry semantics, idempotency/reconciliation capabilities and rates cannot be edited in place after creation; changes require a new descriptor version. This guarantees that an accepted resource quote continues to reference the same pricing semantics used by the single M06 execution path.

Accepted resource-quote economic terms, reservation/execution quote bindings and execution billing scope are immutable after binding. Quote status may only advance through its valid lifecycle. Usage receipts are append-only evidence and cannot be updated or deleted. Operational state that does not rewrite historical billing meaning, such as enabling/disabling a descriptor or advancing execution status, remains mutable.
