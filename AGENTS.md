# NewHumans repository-wide agent instructions

These instructions apply to every development task in this repository.

## Current owner sequencing

Before choosing the next implementation slice, read [`docs/CURRENT_DEVELOPMENT_SEQUENCE.md`](docs/CURRENT_DEVELOPMENT_SEQUENCE.md). While that override is ACTIVE, M03 / Knowledge Ball remains deferred; only independently correct M02/later work may proceed, and no temporary M03, fake-memory, or production memoryless-cognition path may be introduced. If the next correct implementation requires unresolved M03 semantics, stop before code and return for owner discussion.

This sequencing override changes development order only. It does not override V3 module ownership, data authority, identity, Energy, or interface semantics.

## Mandatory acceptance order

For every implementation, fix, modification, refactor, migration or replacement, use this order:

1. **Design conformance first** — compare the intended behavior with the current authoritative V3 design and module ownership before treating tests as evidence.
2. **Invoke `PERFECT_REPLACEMENT`** — explicitly determine whether this change replaces any existing implementation, path, field, API, state, configuration, fallback, UI flow, test assumption or documentation contract.
3. **Regression and cross-surface consistency** — preserve all unaffected behavior and design invariants; keep frontend, backend, database, API, schemas, configuration, tests and documentation on one current semantic path.
4. **Tests and acceptance** — automated tests prove the reviewed implementation; green tests never override a design mismatch or an incomplete replacement.
5. **Final-head verification** — completion requires the final PR head to satisfy the above and pass required CI.

## `PERFECT_REPLACEMENT` — Single Authoritative Path

This command is automatically applicable as an audit to every change. When a new implementation replaces an old one, replacement is complete only when the repository has **one current authoritative executable path** for that behavior.

A replacement must:

- identify the old implementation and every reference to it;
- remove or permanently disable superseded executable paths, duplicate APIs, stale fields, old state transitions, fallbacks, workers/jobs, configuration branches and UI calls;
- update database authority, schemas, frontend/backend contracts, tests, examples and documentation to the same semantics;
- preserve all unaffected behavior, security, authorization, idempotency, accounting and persistence invariants;
- prove that no normal, error, retry, fallback or background path can silently re-enter the superseded implementation.

Do not keep an old business path "for safety" after its replacement is authoritative.

Historical migrations, immutable events, audit logs and historical records may remain when required for traceability. They must be explicitly historical and must not remain a second source of current truth or a callable current business path.

If temporary compatibility is genuinely required, it must have a single authoritative write path, an explicit removal condition/version, and tests proving it cannot create dual truth.

## Required PR evidence

Every PR must contain exactly one audit declaration:

- `Replacement-Audit: APPLICABLE` when current behavior is being replaced; or
- `Replacement-Audit: NOT_APPLICABLE` when no existing behavior is superseded.

When `APPLICABLE`, the PR must also contain:

- `Superseded-Paths:` describing the old paths/semantics;
- `Cleanup-Evidence:` describing how those paths were removed/disabled and how repository-wide references were checked;
- `Regression-Evidence:` describing how unaffected behavior was verified.

The target invariant is:

**one design -> one authoritative data model -> one business semantic -> one current execution path.**
