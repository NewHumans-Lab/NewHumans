# P1.4 final contract closure

Status: **VERIFIED**, including the post-merge P1.4.1 billing-evidence hardening.

This slice closes the remaining literal V3 P0/P1 contract gaps before P2 begins. Acceptance uses design conformance first, followed by PostgreSQL 16 CI on the implementation and final documentation heads.

## Closed contracts

### Trusted world context

The canonical `nh.v3.0` command envelope contains the command version/type/idempotency metadata and payload, but not `world_id`. Current world and actor are trusted server context. The development HTTP adapter represents them with headers only because production authentication is still intentionally blocked. A business request that supplies `worldId`/`world_id` in its body is rejected.

Upgrade compatibility is preserved: internal Action hashing still includes the trusted world in the historical payload shape, so a retry of a pre-P1.4 command does not become an artificial `IDEMPOTENCY_CONFLICT` merely because the transport moved world out of the body.

### Quote-backed platform billing

A new platform-paid model execution is:

```text
M05 resource quote
  -> M05 quote-backed reservation
  -> M06 execution
  -> M06 measured usage receipt
  -> M05 exact settlement / release of unused capacity
```

`economy.resource_quotes` snapshots payer, activity subject, descriptor/version, token bounds, rate snapshot, maximum cost and expiry. Reservation and execution both retain `quote_id`.

New public HTTP inference requires an explicit quote. The internal service has one narrow upgrade bridge for an already-created P1.3 reservation: before its first upgraded execution it may create an audit-labelled compatibility quote and bind that quote to the reservation. This bridge is not exposed as a new-client bypass.

P1.4.1 additionally seals the economic authority behind this chain: versioned descriptor pricing/limits/retry semantics cannot be edited in place, accepted quote terms cannot drift, reservation/execution quote bindings cannot be rebound, and usage receipts are append-only evidence. Price or execution-contract changes require a new descriptor version.

BYOK remains outside the platform model-cost quote/reservation chain because its external model bill is paid by the external account; NewHumans still records usage and applies independent activity-day rules.

### Retry semantics

The V3 meaning is executable: `max_retries` is 0..3 and excludes the initial attempt. Therefore `max_retries=3` means at most four total provider attempts. The database attempt bound is four. Legacy internal `maxAttempts` input is translated for compatibility; new database/machine surfaces use `max_retries`.

### Cancel and receipt APIs

- `gateway.cancel`: a PROPOSED execution can be truthfully cancelled and its active quote-backed reservation released. A DISPATCHED request is not falsely marked cancelled when no provider cancellation protocol exists.
- `gateway.get_usage_receipt`: returns one receipt only to SYSTEM or an execution participant (activity subject/payer), with its execution and quote linkage.

## Verification evidence

PR #9 implementation head `51ca987a29f645b81f1d9308a2c9fe7fa6df41ce` passed `P0-P1 CI` run `35067780832` before merge. Merge commit `7912413cbb287c3e356d6a7adab31eee1ae010fd` then passed the main-branch push workflow run `35068834380`.

The subsequent design audit identified descriptor-contract mutability as a remaining billing-semantic hole. P1.4.1 closes it with migration `006`; PR #12 implementation head `f042561c063f27335a8d7751a025d0cda8aec763` passed run `35070363734` (run #22), including `PERFECT_REPLACEMENT`, empty PostgreSQL 16 migrations `001`–`006`, and the complete test suite. The final documentation head must remain green before closure.

## Acceptance cases

The verified P0/P1 closure covers:

1. migrations `001` through `006` apply cleanly from an empty PostgreSQL 16 database;
2. command-envelope schema rejects client `world_id` and trusted request context supplies the world;
3. legacy P0/P1/P1.1/P1.2/P1.3 regressions remain green;
4. platform-paid execution preserves `quote_id` through reservation, execution and receipt/settlement;
5. strict P1.4 inference refuses an unquoted reservation before provider dispatch;
6. `max_retries=3` permits exactly an initial attempt plus at most three retries;
7. pre-dispatch cancellation releases reservation and cancels the quote;
8. receipt lookup enforces same-world participant visibility;
9. accepted pricing/quote/billing evidence cannot be silently rewritten in place;
10. JSON Schemas compile, JavaScript syntax checks pass, and the mandatory replacement audit passes.

## Still outside P1

P1/P1.4 does not claim production authentication/KMS, real cloud/local-provider verification, M02 persistent life/model routes, M03 Knowledge Ball, M04 contracts/social collaboration, full provider reconciliation polling, provider-specific in-flight cancellation, public search/files/code tools, or 3D world UI.
