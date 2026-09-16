# Changelog

## Unreleased — P0/P1 foundation

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
