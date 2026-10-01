# NH-011 Cross-product Saga protocol

Status: **AUTHORITATIVE**  
Date: 2026-10-01  
Scope: NewHumans contract state coordinated with Knowledge Ball authoritative Economy/Energy/escrow state.

NH-002 establishes Knowledge Ball as the only writable Economy authority and NewHumans as the contract/relationship authority. Therefore contract activation, escrow and settlement cross an authority and database boundary. NewHumans and Knowledge Ball **do not share an ACID transaction**. Each product uses local ACID; cross-product correctness comes from durable Saga state, a transactional NH Outbox, KB-side durable idempotency, callback/inbox dedupe and reconciliation.

NH-011 is the workflow-level contract. NH-005 (`nh.kb-economy-port.v1`) is the authoritative NewHumans-side Economy boundary used to submit escrow operations, while NH-009 (`nh.kb-idempotency.v1`) is the normative lower-level cross-product idempotency/retry contract behind those logical writes. NH-011 defines ordering, durable intermediate states, compensation and forward recovery; it does not redefine or weaken either lower-level contract.

This protocol supersedes earlier wording in `docs/NewHumans_System_Spec_V3.md`, M04 section 7 and M08 section 8 wherever those texts assume that NewHumans contract rows and the authoritative Energy ledger can commit or roll back in one database transaction. Historical wording is not evidence of a current cross-database transaction.

## 1. Authority boundary

- **NewHumans DB** owns contract version, acceptances, lifecycle, dispute/settlement decision, Saga coordinator state, NH Outbox and NH Inbox/result observations.
- **Knowledge Ball** owns Energy wallets, reservations, escrow, ledger journals, financial idempotency evidence and authoritative financial operation status.
- NewHumans may persist `escrow_ref`, `operation_ref`, result receipts and read projections. These are references/evidence, never a shadow wallet or second ledger.
- Knowledge Ball never writes the NewHumans contract to `ACTIVE` or `SETTLED`.
- NewHumans never directly writes KB wallet/escrow tables and never falls back to the Legacy local Economy path when KB is unavailable.
- XA/2PC, cross-database rollback, a shared PostgreSQL transaction and “HTTP call inside one DB transaction” are not part of this protocol.

The cross-product invariant is:

> every state change is atomic only inside its authority; every money-moving effect has one stable logical idempotency identity; every non-terminal Saga has a deterministic recovery path that cannot create a second funds mutation.

## 2. Two-layer idempotency

Funds safety needs two distinct layers.

### Layer A — NewHumans business-attempt idempotency

The user/system command that starts activation or settlement already has a NewHumans command idempotency identity. The NH prepare transaction must persist a stable `business_attempt_id` derived from that durable action/command identity and create **at most one non-terminal coordinator intent for that business attempt**.

Required database protection:

- `saga_id` is unique;
- `(world_id, kind, business_attempt_id)` is unique;
- a contract/version cannot have two simultaneously active Sagas for the same transition class;
- replay of the original NH command returns/reuses its original Saga rather than minting another business attempt.

If a duplicate coordinator row were nevertheless produced with a different `saga_id` but the same `business_attempt_id`, its KB funds key is still identical. This is defense in depth; it does not replace the NH uniqueness constraint.

A definite no-effect failure may later be retried only after current state is revalidated and a **new business attempt** is explicitly created. An unknown outcome never authorizes a new business attempt.

### Layer B — NH-005 EconomyPort + NH-009 cross-product funds identity

Every Saga financial step derives one stable `idempotency_key` from:

```text
(world_id, business_attempt_id, saga_step)
```

The Saga step distinguishes activation funding, activation refund compensation and settlement distribution. `business_attempt_id` is also the stable NH-009 `correlation_id` for all financial steps in that business workflow.

The durable Saga snapshot is shaped for NH-005: a stable `principal_ref` plus an `escrow` payload containing `escrow_action`, `contract_ref`, `amount_micro_e` and any operation-specific allocation/evidence fields. `escrow_action` is inside the EconomyPort payload, never a competing top-level Saga-only wire field. The Saga computes the NH-009 `NH-KB-CJSON-1` digest over the immutable `{ principal_ref, payload }` business snapshot.

The Saga Outbox stores a **logical financial intent**, not a transport attempt. For each actual send, the dispatcher materializes an NH-005 EconomyPort request with the same `idempotency_key`, `principal_ref` and payload, but a **fresh `request_id`**. The KB adapter carries the stable NH-009 correlation/digest context and the shared global retry budget across product boundaries.

Same NH-009 scope/key + same digest returns the original KB result. Same scope/key + different digest is `IDEMPOTENCY_CONFLICT` and produces zero additional funds effects. An `OUTCOME_UNKNOWN` result is never treated as a definite failure and never rotates the idempotency key.

## 3. Required durable records

The exact tables belong to their owning implementation task, but these semantics are mandatory.

### NewHumans Saga

Persist at least:

- `saga_id`, `business_attempt_id`, `kind`;
- `world_id`, `contract_id`, immutable `contract_version`;
- Saga state;
- primary step, stable `idempotency_key`, `principal_ref`, payload digest and immutable NH-005 escrow payload snapshot;
- observed KB result/ref/error, if known;
- activation-compensation key/request/result when applicable;
- retry/reconciliation metadata and timestamps.

### NewHumans transactional Outbox

The NH transaction that creates a Saga or creates a compensation intent commits the corresponding Outbox row in the **same NH-local transaction**. The Outbox stores the Saga/business attempt, funds key, stable correlation ID, `principal_ref`, payload digest, immutable NH-005 payload and delivery metadata. Network dispatch happens only after NH commit.

Publishing is at-least-once. A dispatcher may issue another NH-005 request only when NH-009 retry policy allows; it must preserve the logical funds identity and payload while generating a fresh transport `request_id`.

### NewHumans Inbox / result observation

An EconomyPort response/callback is evidence about an existing funds operation, not authority to create a new one. Because the NH-005 response is transport-oriented, the Inbox/Outbox correlation record binds it back to the existing Saga `idempotency_key` and stored payload digest. Exact duplicate authoritative results are no-ops. Conflicting durable results for one idempotency identity freeze automated progress and require reconciliation review.

### Knowledge Ball funds idempotency

At the KB mutation boundary, NH-009 requires the idempotency scope, payload digest, current/terminal status and resulting ledger/escrow reference to be durably protected with the money mutation in one KB-local decision boundary. Client-side dedupe is insufficient.

## 4. Economy boundary mapping

The durable Saga command is a **logical financial intent**, not one HTTP attempt. All three financial steps use NH-005 operation `escrow`:

| Saga step | NH-005 payload `escrow_action` | Class |
| --- | --- | --- |
| activation funding | `FUND` | `FUNDS_WRITE` |
| settlement distribution | `DISTRIBUTE` | `FUNDS_WRITE` |
| activation compensation | `REFUND` | `FUNDS_WRITE` |

The minimum materialized NH-005 request is:

```text
contract_version = nh.kb-economy-port.v1
operation        = escrow
request_id        = fresh per transport attempt
idempotency_key   = stable Saga funds key
principal_ref     = frozen Saga principal
payload = {
  escrow_action,
  contract_ref,
  amount_micro_e,
  ...immutable operation-specific fields
}
```

NH-005 does not replace NH-009. The EconomyPort request is the NewHumans-side API shape; the adapter/cross-product layer preserves `correlation_id = business_attempt_id`, NH-009 payload digest and shared execution-attempt budget. A status/reconciliation lookup is not a new financial business attempt.

## 5. Contract activation Saga

The contract remains non-`ACTIVE` while funding is pending, unavailable or outcome-unknown.

### NH prepare transaction

1. Revalidate authorization, both acceptances of the same contract version, current contract state and required terms.
2. Resolve/reuse the durable `business_attempt_id` from the idempotent NH command.
3. Freeze the NH-005 `principal_ref` and complete `FUND` payload (`contract_ref`, `amount_micro_e`, plus any atomic prepay/allocation fields).
4. Create/reuse `CONTRACT_ACTIVATION` Saga in `PENDING_REMOTE`.
5. If activation includes prepay plus remaining escrow, those money legs must be represented as one KB-local atomic business operation; NewHumans cannot emulate atomicity by several independent remote transfers.
6. Insert the NH Outbox logical financial intent in the same NH transaction.
7. Commit NH.

At this point the only cross-product fact is durable intent; NewHumans does not claim that Energy moved.

### KB execution

The dispatcher sends an NH-005 `escrow/FUND` request using the Saga's stable idempotency identity. The adapter applies NH-009 funds-write semantics. The idempotency decision, all required financial postings and the escrow/result reference commit atomically inside KB's authority boundary.

The canonical NH-008 error model, NH-005 response contract and NH-009 retry contract jointly govern recovery:

- an ambiguous timeout/connection loss after dispatch or NH-005 `OUTCOME_UNKNOWN` is reconciled before replay;
- a `TIMEOUT` is directly retryable only under the same idempotency key and only when the boundary semantics permit another attempt;
- `UNAVAILABLE` before dispatch or another proven no-effect retryable failure may retry under the same identity and shared global retry budget;
- `INSUFFICIENT_ENERGY`, authorization/binding failure or another definite no-effect terminal failure does not advance the contract;
- every actual retry uses a fresh NH-005 `request_id`; status lookup does not consume an execution attempt.

### NH completion transaction

After a confirmed KB success, NewHumans atomically:

1. records the authoritative KB result/escrow reference;
2. rechecks that the Saga still targets the required contract/version and that no permanent invalidation requires compensation;
3. changes the contract to `ACTIVE`;
4. marks the Saga `COMPLETED`;
5. appends the contract activation event and any downstream NH Outbox records.

Only this NH-local commit makes the contract `ACTIVE`. The M04 data-layer requirement for an external escrow reference is a local integrity check; it is not a substitute for Saga-confirmed KB funding success.

### Activation compensation

Compensation is legal only after **confirmed** KB funding success when a permanent NewHumans-side condition now makes the matching ACTIVE commit illegal. NewHumans then durably creates an NH-005 `escrow/REFUND` step with its own deterministic idempotency key, the same business correlation, and the original frozen `contract_ref`, principal and amount plus the authoritative escrow/result reference.

A crash, lost callback, timeout or failed NH commit is **not** a compensation trigger. Those conditions recover by querying the original funding identity and completing the NH-local activation. Compensation is for proven permanent invalidation, not uncertainty.

## 6. Settlement Saga

Settlement has intentionally asymmetric recovery: after KB distributes escrow successfully, recovery must converge **forward** to `SETTLED`.

### NH prepare transaction

1. Verify the contract/decision state permits settlement.
2. Resolve/reuse the settlement business attempt.
3. Freeze the NH-005 principal, `contract_ref`, total `amount_micro_e` and complete immutable allocation snapshot; destinations and amounts are explicit and the total must equal the distributable escrow under the accepted rule/decision.
4. Create/reuse `CONTRACT_SETTLEMENT` Saga and the NH Outbox `escrow/DISTRIBUTE` intent in one NH transaction.
5. Commit NH while the contract remains pre-`SETTLED`.

### KB execution

KB distributes the whole allocation in one KB-local atomic ledger operation under one idempotency identity. A NewHumans loop that issues independent recipient payments cannot satisfy this contract; atomic distribution belongs to the KB Economy authority.

### NH completion

After confirmed KB success, NewHumans atomically stores the KB result reference, marks the contract `SETTLED`, completes the Saga and writes its local event/outbox records.

If KB succeeded but the NH transaction failed, reconciliation re-observes the same stored result and retries **only the NH-local completion**. Automatic clawback/refund is forbidden. Any later reversal would be a new authorized economic decision with a new business intent, not crash recovery.

The M04 database state machine may enforce local transition legality and timestamps, but it is not financial authority: application/coordinator code may authorize `SETTLED` only after this Saga has a confirmed KB distribution result.

A cancellation/refund decision made before distribution is encoded in the settlement allocation itself rather than “pay first, automatically reverse later”.

## 7. Reconciliation protocol

Callbacks improve latency but are not required for correctness. A reconciler scans every non-terminal Saga after a bounded delay and follows NH-009: first query KB using the same authoritative idempotency scope; only a conclusive status permits the next action.

| Authoritative observation | Required NewHumans action |
| --- | --- |
| `SUCCEEDED` / stored duplicate success | bind the authoritative result back to the existing Outbox/Saga identity, apply it idempotently, then perform only the missing NH-local transition |
| `IN_PROGRESS` / stored active operation | keep the Saga pending; poll later; do not start a parallel duplicate |
| `OUTCOME_UNKNOWN` with no conclusive lookup | keep pending and query; do not replay |
| authoritative `NOT_FOUND` after an unknown attempt | if NH-009 retry budget/policy permits, resend the same NH-005 idempotency key/principal/payload with a fresh request ID |
| proven retryable no-effect failure | retry the same logical operation within the shared global retry budget |
| definite terminal failure with no financial effect | mark Saga failed; contract stays unadvanced; later retry requires full revalidation and a new business attempt |
| same identity with different digest or conflicting durable result | freeze automation and enter manual reconciliation |
| KB unavailable / lookup inconclusive | remain unresolved; never mint a replacement money-moving key |

Reconciliation is the recovery authority for lost callbacks and the critical **KB committed / NH did not commit** window.

## 8. Crash-point matrix

| Crash point | Durable state after restart | Recovery | New funds operation? |
| --- | --- | --- | --- |
| before NH prepare commit | no new Saga/Outbox | retry original NH business command; command idempotency decides whether an earlier prepare actually committed | no |
| after NH prepare+Outbox commit, before send | `PENDING_REMOTE` + durable Outbox | materialize NH-005 request for same funds identity | no new logical operation |
| after send, before KB commit/decision | NH pending; KB absent/in-progress/unknown | query first; resend only when NH-009 permits, using same NH-005 idempotency key/payload and fresh request ID | no new key |
| after KB commit, before response/callback | NH pending; KB success durable | query same identity and obtain stored success | no |
| after callback received, before NH observation commit | NH may still show pending | callback redelivery/reconciler reapplies same result | no |
| after NH observes success, before ACTIVE/SETTLED local commit | `REMOTE_SUCCEEDED` | commit local business transition only | no |
| after NH business completion commit, before callback ack | completed Saga + ACTIVE/SETTLED | duplicate callback is a no-op | no |
| activation: KB success + proven permanent NH invalidation | funded escrow, non-ACTIVE contract | create/reuse deterministic NH-005 `REFUND` compensation step | exactly one compensation logical operation |
| after compensation send/result loss | `COMPENSATION_PENDING` | query/retry same compensation identity under NH-009 | no new key |
| settlement: KB success + NH SETTLED commit failure | money distributed, NH pre-SETTLED | replay stored KB success and commit SETTLED locally | no compensation, no second distribution |

## 9. Duplicate and ordering rules

1. Duplicate original NH commands reuse the same business attempt/Saga.
2. Duplicate Outbox delivery creates another transport attempt only when NH-009 retry policy allows; it never creates a new logical funds identity.
3. Each actual retry gets a fresh NH-005 `request_id`; its idempotency key, frozen principal/payload, correlation ID and digest remain stable.
4. Duplicate exact KB callbacks/results are no-ops.
5. Success followed by a conflicting failure, different result reference or different digest for the same funds identity is a protocol fault; automated money movement stops.
6. Out-of-order primary callbacks after Saga completion or during activation compensation are accepted only if they exactly match the already-recorded primary result.
7. Contract version and the financial snapshot are immutable for one Saga. Changed terms require the proper new contract version and a newly authorized business attempt.
8. Rebuilding events, projections or KB indexes never dispatches a funds mutation outside the Saga/Outbox + EconomyPort/NH-009 path.
9. Reconciliation/status lookups do not themselves create a financial business attempt and do not consume NH-009 write retry budget.

## 10. State machine contract

Executable workflow semantics are in `src/shared/cross_product_saga.js`; the concrete Economy API is `src/ports/economy_port.js` (NH-005), and transport-attempt/retry identity is governed by `src/integrations/knowledge-ball/idempotency-retry.js` (NH-009).

- `PENDING_REMOTE`: reconcile/query; any permitted resend is the same funds identity and immutable NH-005 payload.
- `REMOTE_SUCCEEDED`: KB effect is confirmed; only the matching NH-local business commit remains.
- `FAILED`: definite primary no-effect failure; no automatic key rotation.
- `COMPLETED`: this Saga has converged across both authorities.
- `COMPENSATION_PENDING`: activation-only deterministic refund is unresolved.
- `COMPENSATED`: activation funding was refunded once.
- `RECONCILIATION_REQUIRED`: an exceptional conflict needs explicit review/resolution.

`CONTRACT_SETTLEMENT` never enters compensation states.

## 11. Acceptance gates

NH-011 passes only when all are true:

- current authoritative semantics never claim cross-database ACID, shared rollback or a second NewHumans Economy authority;
- NH-011 funds intents conform to NH-005 EconomyPort escrow request semantics and NH-009 idempotency/digest/correlation/retry semantics rather than implementing competing wire or retry contracts;
- duplicate business requests cannot create two independent funding/settlement attempts;
- `ACTIVE` is impossible before confirmed escrow funding;
- `SETTLED` is impossible before confirmed KB distribution;
- KB success + NH commit failure is recoverable from the original funds identity/result;
- unknown outcomes are reconciled before replay and never cause a new funds key;
- every money-moving retry preserves idempotency key, frozen principal/payload, correlation ID and payload digest while using a fresh transport request ID;
- same key + different payload is rejected;
- duplicate callbacks/outbox deliveries cannot create a second fund/refund/distribution;
- settlement success converges forward and is never automatically clawed back;
- every non-terminal state has retry, reconciliation, compensation or manual-review semantics;
- Knowledge Ball internals and PR #17 runtime/server hotspot files remain untouched by NH-011.
