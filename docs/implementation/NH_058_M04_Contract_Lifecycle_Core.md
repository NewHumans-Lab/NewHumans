# NH-058 — M04 contract proposal, versioning, and acceptance core

Status: implementation candidate; public HTTP routes intentionally remain a separate task.

## Design alignment

This task implements only the non-financial M04 domain slice defined by the module contract and nh.v3.0 command semantics:

- M04 owns contract proposal, immutable terms versions, party acceptance, and acceptance invalidation when a new version is published.
- The authenticated actor is supplied by the trusted M01 command context; actor IDs are not accepted as a substitute for authentication.
- Both parties must accept the same current version before activation can be prepared by the existing cross-product Saga.
- This service does not set a contract ACTIVE, create a Saga/Outbox command, or move funds.
- Knowledge Ball remains the only writable Economy authority; no KB code, ledger, or identity internals are modified.

## Implemented

- proposeContract: creates a PROPOSED contract and immutable version 1 in the caller's existing database transaction.
- publishContractVersion: uses expectedVersion, allows edits only while PROPOSED, appends the next immutable version, and invalidates old-version acceptances.
- acceptContractVersion: requires a contract party and the exact current version; a party's existing acceptance is returned instead of duplicated.
- Integration coverage checks no financial Outbox side effect, party authorization, repeat acceptance, stale-version rejection, and old acceptance invalidation.

## Follow-up task decomposition (dependency order)

1. NH-059 — M04 delivery/review/dispute workflow. Add submit-delivery, review/accept/rework, and raise/resolve dispute domain operations, with version-bound evidence and explicit actor-role checks. This precedes any settlement API.
2. NH-060 — trusted identity-to-Knowledge-Ball principal binding. Add a versioned, auditable M01-owned binding provider/resolver. Never accept client-supplied principal_ref as authority. Add uniqueness, revocation, world scoping, and test doubles. Keep financial routes fail-closed until this exists.
3. NH-061 — authoritative escrow snapshot and settlement invariant. Extend the EconomyPort/adapter contract to return an authoritative escrow balance and operation receipt; validate frozen allocations equal the actual distributable escrow balance, not merely contract price. Cover prepayment and partial disbursement.
4. NH-062 — public M04 API wiring. Add routes for proposal/version/acceptance/delivery/review/dispute with trusted M01 context, canonical command envelopes, idempotency, and explicit authorization. Wire activation/settlement only after NH-060 and NH-061 pass.
5. NH-063 — lifecycle end-to-end and recovery tests. Verify both-party same-version acceptance, escrow funding, delivery, acceptance/rework, dispute adjudication, settlement, duplicate requests, crash recovery, and unknown outcomes.
6. NH-064 — release readiness audit. Reconcile implementation and docs with NH-002, NH-005, NH-009, NH-011, M04 and shared interface contract; do not declare release-ready until a real KB adapter has passed live verification.

## Known limitations

- This PR adds service-level domain operations only; no HTTP route is exposed yet.
- Trusted M01 authentication is currently a development adapter in the HTTP server; do not treat header-derived actor IDs as production authentication.
- Trusted principal binding, authoritative escrow balance, and live KB adapter verification remain separate gates.
