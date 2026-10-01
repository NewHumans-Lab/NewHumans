# NH-010 — KB Readiness / Capability Contract

Status: implementation contract for the NewHumans ↔ Knowledge Ball boundary.

## Scope

Knowledge Ball remains an independent product and authority. NewHumans consumes its Economy, Memory, and Knowledge capabilities through boundary ports/adapters. This contract reports capability availability without creating a second Knowledge Ball implementation or touching Knowledge Ball internals.

The three required capability keys are:

- `economy`
- `memory`
- `knowledge`

Each capability reports independent `read_ready` and `write_ready` booleans. Missing capability reports are treated as unavailable (`reported=false`, `read_ready=false`, `write_ready=false`, reason `NOT_REPORTED`).

## Aggregate readiness

`overall` is derived, never asserted by the caller:

- `READY`: all three capabilities are both read-ready and write-ready.
- `UNAVAILABLE`: no read or write slot is ready.
- `DEGRADED`: every other partial state.

Therefore a partial state such as `E✓ M✗ K✓` is explicitly `DEGRADED`; it cannot be represented as a healthy KB.

## Operation gating

A caller declares the KB capabilities required by one operation and the access mode (`read` or `write`). The contract evaluates exactly those dependencies.

For writes, `assertKbWriteReady()` is fail-closed: if any required capability is not `write_ready`, it throws `KbCapabilityWriteBlockedError` before the caller is allowed to dispatch that KB write. An unrelated failed capability does not disable an otherwise independent operation.

Example: when Economy and Knowledge are ready but Memory is unavailable:

- an Economy-only write may proceed;
- a Knowledge-only write may proceed;
- any write requiring Memory is blocked;
- `overall` remains `DEGRADED`.

Unknown capability names are rejected instead of being treated as ready.

## Ownership boundaries with adjacent first-batch tasks

This contract does not define transport error codes, retryability, reconciliation, idempotency keys, retry budgets, or individual Economy/Memory/Knowledge business methods.

- NH-005 owns `EconomyPort` business operations.
- NH-006 owns `MemoryPort` business operations.
- NH-007 owns `KnowledgePort` business operations.
- NH-008 owns canonical KB error mapping and retryability/reconciliation classification.
- NH-009 owns idempotency and retry semantics.

NH-010 only owns capability readiness aggregation and access gating.

## Acceptance invariants

1. No unavailable or missing child capability may produce `overall=READY`.
2. Partial failure matrices preserve healthy sibling capabilities while reporting `DEGRADED` globally.
3. A write that declares a failed required capability is blocked locally before dispatch.
4. Unknown capabilities cannot bypass gating.
5. No runtime hot file, server entry point, local ledger, memory fallback, or Knowledge Ball internal implementation is introduced by this task.
