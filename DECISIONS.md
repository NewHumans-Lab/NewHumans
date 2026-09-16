# Architecture decisions

## ADR-001 — V3 is the P0/P1 contract baseline
Status: Accepted · 2026-09-16

Implementation uses `nh.v3.0`. Core semantic changes require a new protocol version; configuration-only changes must not silently redefine persisted meaning.

## ADR-002 — Modular monolith before microservices
Status: Accepted

P0/P1 uses one Node.js service and one PostgreSQL database with `core.*` and `economy.*` schemas. Cross-domain invariants remain transactional. Module ownership is preserved in schema and service boundaries without introducing distributed transactions.

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

`POST /api/v1/dev/bootstrap` is available only when `LOCAL_DEV_BOOTSTRAP=true` and `NODE_ENV != production`. Production identity verification is not simulated or claimed by P0/P1.

## ADR-008 — World isolation is a database invariant
Status: Accepted · 2026-09-16

Any table that stores both `world_id` and an Entity reference uses a composite foreign key to `(world_id, entity_id)`. Application checks remain useful error handling, but they are not the final authority for cross-world integrity. Ledger postings, which inherit world from their journal, use a database trigger to reject an Entity from another world.

## ADR-009 — Energy journals are sealed append-only records
Status: Accepted · 2026-09-16

Committed `economy.journals` and `economy.postings` cannot be updated or deleted. A journal records its expected posting count; deferred database constraints require the final count to match and the signed sum to equal zero. Later balanced postings cannot be appended to an already committed journal. Corrections use a new `REVERSAL` journal referencing the original.

## ADR-010 — The canonical command contract is snake_case `nh.v3.0`
Status: Accepted · 2026-09-16

`schemas/command-envelope.schema.json` follows the authoritative Shared Contracts document: `schema_version`, `world_id`, `command_type`, `idempotency_key`, optional contract metadata and `payload`. The HTTP adapter constructs and validates this envelope from route/body/header inputs; authenticated actor identity remains server-bound and is never accepted from the command envelope.
