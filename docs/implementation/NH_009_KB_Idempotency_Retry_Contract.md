# NH-009 — Knowledge Ball cross-product idempotency and retry contract

Status: normative NewHumans boundary contract  
Contract version: `nh.kb-idempotency.v1`  
Authority: Knowledge Ball  
Scope: Knowledge Ball standalone ↔ NewHumans embedded/integration calls. This contract does not move Knowledge Ball business state into NewHumans and does not modify Knowledge Ball internals.

## 1. Purpose and authority

Knowledge Ball remains the authoritative product for its own knowledge, memory, and Energy/economy state. NewHumans is a caller/host at this boundary. A network retry, UI retry, queue redelivery, process restart, or a request crossing from one product surface to the other MUST NOT create a second logical write.

This contract specializes the existing `nh.v3.0` command-envelope rules for the cross-product boundary. It does not replace the shared contract. In particular, the existing rules that same-key/same-payload returns the original action, same-key/different-payload is `IDEMPOTENCY_CONFLICT`, and default `max_retries = 3` remain authoritative.

## 2. Identifiers

### 2.1 Idempotency key

`idempotency_key` identifies one logical write. It MUST be created before the first execution attempt and MUST remain byte-for-byte identical for every retry, queue redelivery, product hop, or reconciliation of that logical write.

The authoritative uniqueness scope is:

```text
(authority = knowledge-ball,
 world_id,
 actor_entity_id,
 operation,
 idempotency_key)
```

`origin_product`, `request_id`, `correlation_id`, attempt number, network connection, process ID, and timestamp are deliberately NOT part of the uniqueness scope. Otherwise the same logical operation could execute once from Knowledge Ball and again from NewHumans.

The key MUST be opaque to business logic. It MUST NOT be derived only from time, amount, balance, UI route, or request ID. A caller may use a UUID/ULID or another collision-resistant operation token.

### 2.2 Request ID

`request_id` identifies one transport attempt. Every actual send MUST use a fresh request ID, including a retry with the same idempotency key. Reusing a request ID is a protocol error (`REQUEST_ID_REUSED`).

Request ID is for tracing and transport diagnostics. It MUST NOT control business deduplication.

### 2.3 Correlation ID

`correlation_id` identifies the wider business workflow or causal chain. It remains stable across retries of the same logical operation and may also group several different idempotent operations that belong to one workflow.

Changing correlation ID during a retry of the same logical operation is a protocol error (`CORRELATION_ID_CHANGED`). Correlation ID is not a uniqueness key and MUST NOT be used to suppress distinct legitimate writes inside one workflow.

## 3. Payload identity and duplicate semantics

Before execution, the authority persists the idempotency scope and a deterministic SHA-256 payload digest in the same durable decision boundary that protects the business write. NewHumans' reference helper uses `NH-KB-CJSON-1`: plain JSON values, arrays in order, object keys recursively sorted, ECMAScript JSON scalar serialization, then SHA-256 encoded as `sha256:<64 lowercase hex>`.

For a duplicate request:

| Existing record | Incoming request | Required result |
| --- | --- | --- |
| Same scope + same digest + terminal success | same logical write | return the stored success/result/action ID; do not execute or charge again |
| Same scope + same digest + terminal failure | same logical write | return the stored terminal failure; do not execute again unless that failure explicitly represents non-execution and policy permits retry |
| Same scope + same digest + in progress | same logical write | return/indicate current action/job; do not start a parallel duplicate |
| Same scope + same digest + outcome unknown | same logical write | return unknown/reconciliation state; do not blindly replay |
| Same scope + different digest | conflicting logical write | `IDEMPOTENCY_CONFLICT` (409); zero additional side effects |

Stored idempotency evidence MUST survive at least the full business reconciliation window. Funds-write evidence MUST NOT expire while an outcome can still be disputed or reconciled.

## 4. Retry budget

Default `retry_budget = 3` means three retries after the first send, therefore at most four execution attempts end-to-end.

The budget belongs to the logical operation, not to a component. NewHumans, Knowledge Ball, HTTP libraries, workers, and queues MUST share/propagate the same attempt count. They MUST NOT each apply an independent 3-retry loop.

A retry consumes budget only when another execution attempt is actually sent. A status lookup/reconciliation query does not consume execution retry budget.

## 5. Uncertain outcomes and timeout protocol

A transport timeout, connection reset after send, lost response, worker crash after dispatch, or any other condition where commitment is unknown is `OUTCOME_UNKNOWN`. For an `OUTCOME_UNKNOWN` write:

1. Do not send the write again immediately.
2. Query Knowledge Ball's authoritative operation status by the same idempotency scope/key.
3. If found, return/continue from the stored result or in-progress state. No replay.
4. If the authoritative lookup explicitly returns `NOT_FOUND`, a retry may be sent with the same idempotency key, same correlation ID, same payload digest, a new request ID, and remaining budget.
5. If lookup is unavailable, stale, ambiguous, or cannot prove absence, remain `OUTCOME_UNKNOWN`; do not replay an irreversible write.

A normal retryable response is different: it is safe to retry only when the responder definitively states that the business side effect was not committed (for example, rejection before admission). A generic HTTP timeout or 5xx without such proof is not a definitive non-execution signal.

## 6. Funds-write invariant

For `operation_class = FUNDS_WRITE`, the hard invariant is:

> One idempotency scope may produce at most one authoritative funds mutation, regardless of network retries, product surface, queue redelivery, or response loss.

The Knowledge Ball authority MUST enforce durable uniqueness and payload-digest conflict checking at the mutation boundary. NewHumans MUST preserve the same key and MUST use query-before-replay after uncertain outcomes. Client-side retry suppression alone is not sufficient for this invariant.

Examples include Energy transfer, reservation/hold, settlement, escrow funding/distribution, refund, activity fee, and any future operation that changes an authoritative monetary balance.

## 7. Reference state decisions

`decideRetry` in `src/integrations/knowledge-ball/idempotency-retry.js` encodes these boundary decisions:

- `FOUND` → `RETURN_STORED_RESULT`
- terminal success or definitive failure → `STOP`
- `OUTCOME_UNKNOWN` before a conclusive lookup → `QUERY_BY_IDEMPOTENCY_KEY`
- `OUTCOME_UNKNOWN` + authoritative `NOT_FOUND` + budget → `RETRY_SAME_KEY`
- definitive retryable non-execution + budget → `RETRY_SAME_KEY`
- attempt limit reached → `BUDGET_EXHAUSTED`

Every retry keeps the logical scope and digest stable while changing only transport-attempt metadata.

## 8. Acceptance evidence for NH-009

The unit suite must prove at minimum:

- 1,000 duplicate funds requests using the same cross-product idempotency scope execute exactly one authoritative funds mutation;
- duplicates may alternate between `newhumans` and `knowledge-ball` origins without bypassing deduplication;
- a response may be lost after commit and later recovered by lookup without a second write;
- timeout/unknown outcome requires lookup before retry;
- same key with different payload returns `IDEMPOTENCY_CONFLICT` and creates no second write;
- request IDs change per attempt while correlation ID and idempotency scope remain stable;
- default retry budget is globally four total execution attempts, not four attempts per component/product.

## 9. PERFECT_REPLACEMENT audit

`Replacement-Audit: NOT_APPLICABLE`

NH-009 adds a boundary contract and reference helpers where no Knowledge Ball cross-product idempotency implementation currently exists in the NewHumans repository. It does not replace M02 runtime code, M03/Knowledge Ball internals, M05 business logic, or the existing `nh.v3.0` command envelope.
