# NH-057 — Contract settlement decision eligibility

Status: implementation candidate; merge only after required CI gates pass.

Validation status is tracked by the pull request's current GitHub Actions run.

## Change

Before preparing a `CONTRACT_SETTLEMENT` Saga or writing its financial Outbox command, the service now requires durable decision evidence bound to the current contract version:

- `SUBMITTED`: at least one delivery for the same world, contract, and current version must have status `ACCEPTED`.
- `DISPUTED`: at least one dispute for the same world, contract, and current version must be `RESOLVED`, with a non-null resolution and `resolved_by_entity_id`.

A contract status by itself is not treated as an acceptance or adjudication decision. Missing evidence fails closed before any new financial command is enqueued.

## Regression coverage

- Successful settlement fixture now inserts an accepted delivery.
- Allocation-conservation coverage also supplies acceptance evidence, so it continues to test the intended invariant.
- A new integration regression asserts that a submitted contract without an accepted delivery is rejected and does not add a settlement Outbox row.

## Known limitations

- This task does not implement public M04 contract endpoints or trusted identity-to-Knowledge-Ball principal binding.
- It does not verify the actual escrow balance against the allocation total. The current settlement service still uses the frozen contract price; a future change must use a trusted authoritative Knowledge Ball balance/settlement decision, especially where prepayment or partial disbursement is possible.
- No Knowledge Ball code or ledger is changed.
