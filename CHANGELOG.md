# Changelog

## Unreleased — P1.1 foundation hardening

### Added
- Database-level composite `(world_id, entity_id)` foreign keys for world isolation.
- Posting-world guard for ledger rows that inherit world from their journal.
- Append-only protection for committed Energy journals and postings.
- Sealed journal posting counts plus deferred balance/cardinality checks.
- Canonical `nh.v3.0` command-envelope validation in the HTTP adapter.
- JSON Schema compilation in the standard check pipeline.
- Hardening tests for cross-world references, ledger immutability, journal sealing and business-key conflicts.

### Fixed
- Conflicting reuse of an Energy journal business key now returns `IDEMPOTENCY_CONFLICT` instead of silently replaying a journal with different content.
- Machine-readable command field names now match the authoritative Shared Contracts document.

## P0/P1 foundation

### Added
- Node.js modular-monolith skeleton and PostgreSQL migration runner.
- `core` Entity, Action, append-only Event, Outbox, consumer receipt and capability-grant tables.
- `economy` wallets, balanced journals/postings, reservations, daily activity fees and first-activation accounting marker.
- Exact microE amount rules and V3 activation/task-seeking eligibility logic.
- Idempotent command execution with same-key/different-payload rejection.
- Minimal browser console backed by the same HTTP APIs and ledger as programmatic clients.
- Unit and PostgreSQL concurrency/integration tests plus GitHub Actions CI.
- JSON Schemas for command envelope, Entity, Event and Energy wallet.

### Explicitly not included
- M02 Worker/runtime, leases, checkpoints or model switching.
- M03 Knowledge Ball implementation.
- M04 contracts/escrow/social graph.
- M06 real model/tool adapters and token settlement.
- 3D world or production identity provider.
