# P1.4 final contract closure

Status: **IMPLEMENTED; final PR verification pending**.

This slice closes the remaining literal V3 P0/P1 contract gaps before P2 begins. The acceptance order is design conformance first, then PostgreSQL 16 CI on the final PR head.

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

BYOK remains outside the platform model-cost quote/reservation chain because its external model bill is paid by the external account; NewHumans still records usage and applies independent activity-day rules.

### Retry semantics

The V3 meaning is now executable: `max_retries` is 0..3 and excludes the initial attempt. Therefore `max_retries=3` means at most four total provider attempts. The database attempt bound is four. Legacy internal `maxAttempts` input is translated for compatibility; new database/machine surfaces use `max_retries`.

### Cancel and receipt APIs

- `gateway.cancel`: a PROPOSED execution can be truthfully cancelled and its active quote-backed reservation released. A DISPATCHED request is not falsely marked cancelled when no provider cancellation protocol exists.
- `gateway.get_usage_receipt`: returns one receipt only to SYSTEM or an execution participant (activity subject/payer), with its execution and quote linkage.

## Acceptance cases

Final CI must prove from an empty PostgreSQL 16 database:

1. migrations `001` through `005` apply cleanly;
2. command-envelope schema rejects client `world_id` and trusted request context supplies the world;
3. legacy P0/P1/P1.1/P1.2/P1.3 regressions remain green;
4. platform-paid execution preserves `quote_id` through reservation, execution and receipt/settlement;
5. strict P1.4 inference refuses an unquoted reservation before provider dispatch;
6. `max_retries=3` permits exactly an initial attempt plus at most three retries;
7. pre-dispatch cancellation releases reservation and cancels the quote;
8. receipt lookup enforces same-world participant visibility;
9. JSON Schemas compile and all JavaScript syntax checks pass.

## Still outside P1

P1.4 does not claim production authentication/KMS, real cloud/local-provider verification, M02 persistent life/model routes, M03 Knowledge Ball, M04 contracts/social collaboration, full provider reconciliation polling, provider-specific in-flight cancellation, public search/files/code tools, or 3D world UI.
