# P1.4.1 billing evidence immutability

Status: **VERIFIED**.

A post-merge design review of P1.4 found that accepted resource quotes correctly stored pricing snapshots, but the referenced capability descriptor pricing/limit contract could still be edited in place at the database layer. M06 settlement reads the referenced descriptor rates, so an in-place edit after quote acceptance could change billing semantics despite the quote snapshot.

P1.4.1 closes that authority-layer gap without adding a second execution path:

- versioned descriptor execution/pricing/retry contract fields are immutable after creation; changes require a new descriptor version;
- accepted resource-quote economic terms and expiry are immutable;
- quote lifecycle transitions are one-way;
- a reservation may receive its first quote binding for the P1.3 compatibility bridge, but that binding cannot later be changed or removed;
- execution identity, payer, resource, reservation, quote, billing date, purpose, input digest and maximum authorization are immutable after creation;
- usage receipts are append-only evidence and cannot be updated or deleted.

Operational state remains mutable where required: descriptors may still be disabled/enabled, verification metadata can evolve, executions can advance through runtime states, and quotes can advance through their valid lifecycle.

## Verification evidence

PR #12 implementation head `f042561c063f27335a8d7751a025d0cda8aec763` passed `P0-P1 CI` run `35070363734` (run #22) in the controlled PostgreSQL 16 environment. That run passed the mandatory `PERFECT_REPLACEMENT` audit, applied migrations `001` through `006` from an empty database, and passed the complete schema/syntax/unit/integration/regression test command including the new billing-immutability cases.

The final PR head after this evidence documentation is required to pass the same workflow again before PR #12 is considered closed for acceptance.

## Acceptance

P1.4.1 acceptance requires:

1. `PERFECT_REPLACEMENT` audit passes with concrete cleanup/regression evidence;
2. empty PostgreSQL 16 migrations `001` through `006` apply cleanly;
3. all previous P0/P1 through P1.4 regressions remain green;
4. new tests prove in-place descriptor price drift and quote-term mutation are rejected;
5. a new descriptor version can carry new pricing while an already accepted old quote retains its original terms;
6. reservation/execution quote authority cannot be rebound;
7. usage receipts reject UPDATE and DELETE;
8. the final documentation head remains green after verification evidence is recorded.
