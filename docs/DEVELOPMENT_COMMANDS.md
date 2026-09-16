# NewHumans Advanced Development Commands

## `PERFECT_REPLACEMENT`

**Scope:** mandatory audit for every fix, modification, refactor, migration, replacement or behavior change across the entire development lifecycle.

### Purpose

When a new implementation supersedes an old one, the result must be a perfect replacement: the new path fully inherits all still-valid behavior and design constraints, while the old current execution path is completely removed or made non-authoritative.

The repository must not end a change with two different current implementations of the same behavior.

### Trigger

Every development change invokes this audit automatically. The author must first classify the change:

- `APPLICABLE` — some existing current behavior, path, field, state, API, configuration or contract is being superseded.
- `NOT_APPLICABLE` — the change is purely additive and does not supersede an existing current behavior.

`NOT_APPLICABLE` is still an invocation of the command; it is not permission to skip the audit.

### Required procedure when applicable

1. **Identify the replacement boundary.** State exactly what the new implementation replaces.
2. **Trace the old path repository-wide.** Search backend, frontend, database runtime logic, schemas, API handlers, workers/jobs, events/commands, configuration, feature flags, fallback branches, tests, examples and documentation.
3. **Eliminate dual execution.** Remove or permanently disable every superseded current path. Error, retry, fallback and background execution must not re-enter it.
4. **Preserve valid behavior.** Unless the new design explicitly changes a behavior, preserve existing functionality, permissions, security boundaries, idempotency, accounting rules, persistence guarantees and external contracts.
5. **Converge all surfaces.** Frontend, backend, database, API, machine schemas, configuration, tests and documentation must describe and use the same current semantics.
6. **Handle history correctly.** Immutable migrations, historical events, audit logs and historical records may remain for traceability, but cannot continue as current executable logic or a second source of truth.
7. **Bound temporary compatibility.** If compatibility is genuinely required, it must have one authoritative write path, an explicit removal condition/version and tests preventing dual truth.
8. **Prove replacement.** Record superseded paths, cleanup evidence and regression evidence in the PR.

### Forbidden end states

A task is not complete if any of these remain:

- old code is still callable as a current business path;
- old and new APIs both express the same current behavior with different semantics;
- old fields still influence current decisions after new fields became authoritative;
- frontend uses the new path while a worker/background/error path uses the old one;
- a fallback silently returns to deprecated behavior;
- two state machines or two data models are current authorities for the same fact;
- tests pass only because they cover the new path while the old path remains executable;
- documentation and code disagree about which implementation is authoritative;
- a replacement silently removes unrelated valid behavior or design constraints.

### Acceptance order

Every affected task is accepted in this order:

1. design conformance;
2. `PERFECT_REPLACEMENT` / single-path audit;
3. unaffected-function regression review;
4. frontend/backend/database/API/schema/config/documentation consistency;
5. automated and integration tests;
6. final PR-head CI verification.

A green test suite is evidence only after steps 1–4 pass.

### Final invariant

> **One design -> one authoritative data model -> one business semantic -> one current execution path.**

Historical evidence may remain. Historical business logic may not remain active as a parallel current path.
