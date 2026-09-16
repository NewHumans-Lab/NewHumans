# P3-A — M02 Runtime Kernel

Status: **IMPLEMENTED and VERIFIED on PR #14 implementation head**  
Protocol baseline: `nh.v3.0`  
Owner sequencing: M03 / Knowledge Ball is deliberately deferred.

## Purpose

P3-A implements only M02-owned runtime foundations that remain correct regardless of whether the final M03 integration reuses the existing Knowledge Ball or is rebuilt. It does not create a substitute cognition or memory path.

## Implemented authority

- `runtime.agent_profiles`: one runtime profile per AGENT Entity; M01 remains identity authority.
- `runtime.lifecycle_states`: one orthogonal lifecycle/execution/model/restriction/archive state record per runtime subject.
- `runtime.model_manifests`: immutable snapshots that bind an Agent to an existing M06 descriptor/connector execution identity.
- `runtime.model_routes`: immutable versioned route history; `agent_profiles.current_route_id` is the single current pointer.
- `runtime.model_change_events`: append-only route-change evidence.
- `runtime.runtime_leases`: one current Worker lease with monotonically increasing `lease_epoch` after release/expiry takeover.
- `runtime.runtime_checkpoints`: append-only checkpoints fenced by current lease epoch and lifecycle state version at both service and PostgreSQL authority layers.
- `runtime.goals` and `runtime.goal_dependencies`: persistent M02 goal authority. SELF and SYSTEM sources are supported; OWNER/CONTRACT authorization remains explicitly deferred until owning modules are integrated.

## Cross-module boundaries

- **M01 owns identity and authorization context.** P3-A never creates a replacement identity when a model route changes.
- **M05 owns Energy.** P3-A stores optional goal/route budget limits but never edits wallet balances or settles model cost.
- **M06 owns provider execution and credentials.** M02 stores descriptor/connector references and immutable execution metadata snapshots; secrets remain outside runtime tables.
- **M03 owns public knowledge, Personal Overlay, evidence and memory retrieval.** P3-A creates no M03 schema and no substitute memory store.

## M03 dependency gate

`runtime.request_turn` intentionally returns `M03_CONTEXT_UNAVAILABLE`. It does so before activity-fee charging, reservation, M06 execution or any other cognition side effect.

The exposed runtime snapshot explicitly reports:

- `status = BLOCKED_DEPENDENCY`
- `dependency = M03_CONTEXT_PROVIDER`
- `m03Implementation = DEFERRED_BY_OWNER`

This is a hard design boundary, not a temporary feature flag. The future M03 choice must attach to the authoritative context-provider contract; a memoryless/fake-memory alternate turn path is prohibited.

## Design-conformance hardening found before PR

The first P3-A implementation was intentionally reviewed before CI. That review found and corrected authority gaps:

1. route-to-manifest and model-change-to-route relationships were application-validated but not same-Agent constrained by PostgreSQL;
2. immutable M02 manifests could reference a mutable M06 connector whose endpoint/credential/billing identity might drift in place;
3. stale checkpoint fencing existed in the service but direct database insertion did not independently enforce the current lease epoch and exact next state version;
4. runtime machine-readable schemas and explicit sequencing evidence were missing.

The corrected implementation therefore:

- uses same-Agent composite foreign keys for manifest/route/change history;
- makes connector execution identity immutable in place while retaining `enabled` as the operational switch;
- makes PostgreSQL checkpoint insertion itself verify the active lease and advance the one lifecycle state version in the same transaction;
- publishes runtime JSON Schemas and the active owner sequencing override.

## PERFECT_REPLACEMENT audit

P3-A is mostly additive M02 functionality, but the design-conformance hardening replaces previously possible ambiguous mutation paths:

- an existing connector row can no longer be repointed to a different execution identity; create a new connector + manifest + route instead;
- route/change history can no longer cross Agent ownership through direct SQL/future bypass paths;
- checkpoint state advancement has one database-authoritative fenced path rather than a service-only assumption.

Historical rows remain as immutable evidence. No old executable alternative is retained.

## Verification evidence

PR #14 implementation head `f4d02495a56fea1390df5fbbeca7e17910e1c8c3` passed workflow run `35097607749` on PostgreSQL 16.

The run verified:

- mandatory `PERFECT_REPLACEMENT` audit: **PASS** (`APPLICABLE` evidence accepted);
- empty PostgreSQL 16 migration through `008`: **PASS**;
- JavaScript syntax and all JSON Schema compilation: **PASS**;
- unit tests: **14 / 14 PASS**;
- integration/regression tests: **47 / 47 PASS**;
- prior P0/P1/P1.1/P1.2/P1.3/P1.4/P1.4.1 regression coverage remained green;
- P3-A runtime ownership, immutable route history, credential-material rejection, lease concurrency, stale epoch/state-version fencing, goal source boundaries and M03 hard blocking all executed and passed;
- new authority tests for connector immutability, same-Agent composite references and direct-database checkpoint fencing all executed and passed.

This evidence refers to the implementation head above. The documentation-only verification update creates a new PR head, which must also pass the complete CI workflow before final acceptance.

## Not claimed

- full P3 autonomous life loop;
- any M03/Knowledge Ball implementation or adoption;
- Personal Overlay, memory retrieval, knowledge graph, evidence or challenge behavior;
- M04 social/contracts integration;
- runtime activation/dormancy economic coordination as a complete scheduler;
- HPA runtime/recovery/awakening;
- real cloud/local model verification beyond previously verified M06 protocol fixtures;
- production authentication or credential vault.
