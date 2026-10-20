# NH-048 Design Specification Delta

Status: **AUDIT BASELINE RECORDED; SPECIFICATION IS NOT A CLAIM OF PRODUCT COMPLETION**  
Code baseline: `main@4d3986fc507cceb803b7b6670271e53ad9cd20e9` (2026-10-20)  
Design baseline: V3 / protocol `nh.v3.0`, with `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` as the active owner-directed sequencing override.  
Scope: Compare the normative NewHumans design with implementation evidence on main and identify gaps that still require implementation, owner decisions or external verification. This is additive documentation; Knowledge Ball internals are out of scope.

## 1. Status definitions

- **IMPLEMENTED / VERIFIED** — the relevant code and task-level test/merge evidence exist.
- **IMPLEMENTED SLICE** — a bounded part is implemented, but the broader module or user journey is not complete.
- **CONTRACT ONLY / NOT WIRED** — a port, schema, error model or adapter contract exists, but the real runtime path is not integrated.
- **BLOCKED ON FINAL ACCEPTANCE** — a code path exists, but the current required review/CI/merge gate remains open.
- **OWNER-DEFERRED** — implementation is explicitly prohibited by the current owner-directed sequence until a decision or authoritative dependency exists.
- **UNVERIFIED IN REAL ENVIRONMENT** — only code contracts, mocks or local test evidence exist; no live endpoint/production deployment has been proven.
- **NOT IMPLEMENTED IN THIS BASELINE** — implementation evidence was not found in this baseline; this does not rule out external work outside this repository.

A schema or passing focused test is not evidence that all upstream, downstream and UI steps exist. For this refreshed baseline, NH-001 PR #17 is merged at `4d3986fc507cceb803b7b6670271e53ad9cd20e9`; its final-head Task Acceptance passed and the P0-P1 CI run on the merge commit passed. These results are bounded evidence, not proof of full product completion.

## 2. Source-of-truth rules

1. System semantics follow V3 and the confirmed design decisions, with the latest owner-confirmed decisions taking precedence over older conflicting text.
2. `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` is an active sequencing override: M03/Knowledge Ball is intentionally deferred; M02 work may proceed only where correct without inventing M03 semantics.
3. NH-002 defines the authority boundary: Knowledge Ball remains the single writable authority for Economy/Energy, durable Memory and Knowledge; NewHumans remains authoritative for Identity, Lifecycle, Goals and Relationships.
4. Contract/API/schema/adapter code is NewHumans-side boundary work unless explicitly stated otherwise; it must not be described as an implemented Knowledge Ball service or production provider.
5. “Merged” describes repository state. “Verified” requires the named checks. “Product complete” additionally requires actual end-to-end user paths and environment evidence.

## 3. Design-to-implementation traceability

| Design domain | Main implementation/evidence | Delta status | Consequence |
| --- | --- | --- | --- |
| P0/P1 service skeleton, migrations, JSON schemas, CI and core world/entity/action/event contracts | README; `scripts/migrate.js`, `scripts/check.js`; integration tests `p0p1.test.js`, `p1_1_hardening.test.js`; merge/acceptance records for PR #2 and #3. | IMPLEMENTED / HISTORICALLY VERIFIED | Preserve PostgreSQL 16 migrations, syntax/schema checks, unit tests and full integration gate on later changes. Development bootstrap is not production identity verification. |
| M05 journal accounting, Energy precision, reservations/usage settlement and billing evidence | M05 service/schema and PRs #3, #6, #9, #12; regression tests `p1_4_billing_immutability.test.js`, `p1_4_contract_closure.test.js`. | IMPLEMENTED CORE SLICE | This is the NewHumans-local legacy accounting path. NH-012 freezes it as migration debt; it must not remain a second writable authority once the Knowledge Ball cross-product boundary is in production. |
| Identity boundary and one writable Economy/Memory/Knowledge authority | NH-002 ADR (#24); NH-005 EconomyPort (#52); NH-006 MemoryPort (#62); NH-007 KnowledgePort (#61); NH-008 error model (#18); NH-009 retry contract (#66); NH-010 readiness (#25); NH-013 static authority guard (#63). | CONTRACTS / AUTHORITY GUARDS IMPLEMENTED; REMOTE PROVIDER NOT PROVEN | Boundary violations are guarded in NewHumans, but these files do not themselves prove that a production Knowledge Ball endpoint is connected and authoritative at runtime. |
| Cross-product contract activation, escrow and settlement | NH-011 Saga protocol (#65), `src/shared/cross_product_saga.js`, contract-level tests and documentation. | PROTOCOL / REFERENCE STATE MACHINE ONLY | NH-011 explicitly excludes full durable Saga persistence tables and transport wiring. Do not claim operational cross-database escrow or settlement until a dedicated persistence/dispatcher/callback/reconciliation task passes. XA/2PC or dual rollback is not the design. |
| M02 Agent profile, lifecycle, model manifests/routes, goals, leases and checkpoints | `docs/implementation/P3_A_M02_Runtime_Kernel.md`; `docs/implementation/P3_B_Continuous_Runtime_Control.md`; P3-A/P3-B integration test files; merged PR #14/#16/#17. | MERGED / VERIFIED (bounded M02 runtime-control implementation) | NH-001 PR #17 merged as `4d3986fc507cceb803b7b6670271e53ad9cd20e9`; final-head Task Acceptance and P0-P1 CI on the merge commit passed. Full P3 remains incomplete until the authoritative M03 context provider is adopted and the complete chain is integrated. |
| M03 Knowledge, durable memory, Personal Overlay, evidence, challenges, and autonomous-turn context | `docs/modules/03_Knowledge_Ball.md`; NH-006/NH-007 boundary contracts; the active owner-directed sequence. | OWNER-DEFERRED | The product architecture still includes M03, but implementation/adoption is undecided. Keep `M03_CONTEXT_UNAVAILABLE` fail-closed. No temporary cognition service, local shadow memory, or substitute Knowledge Ball is permitted by current direction. |
| M04 Directory and Messaging | NH-021 PR #37; NH-022 PR #46; NH-028/029 schema work; `m04_directory_data.test.js`, `m04_messaging_data.test.js`. | IMPLEMENTED DATA SLICES | Persistence invariants and schemas are implemented, but their existence alone does not prove a complete public API/UI workflow or full M04 product surface. |
| M04 Relationships | NH-023 PR #53; `migrations/0523_m04_relationship_data.sql`, `src/services/social_relationships.js`, `m04_relationships.test.js`. | IMPLEMENTED DATA SLICE | Mutual facts require two-party proposal/confirmation evidence, history is append-only and effective dates are modeled. The stale `CI: PENDING` text inside the merged PR body should not be used as the source of merge state; GitHub records the PR as merged at SHA `1e3cf0ea9436d9f8b76847ba26dd10ef9f794c59`. |
| M04 WorldObject, Space, Contract and Organization | NH-024 (#55), NH-025 (#57), NH-026 (#56), NH-027 (#59) data slices and NH-031/032/033 schemas; corresponding M04 integration tests. | IMPLEMENTED DATA SLICES | Continue testing cross-table composition and version constraints. Space's earlier deferred cross-table reference must be rechecked against the now-merged WorldObject slice; no domain should gain a second wallet, escrow or knowledge authority. |
| M06 gateway, external model provider and usage settlement | `src/services` gateway/usage paths; `tests/integration/m06_gateway.test.js` and `m06_conformance.test.js`; NH-036 Cloud Model Adapter (#48); NH-037 Local Model Adapter (#47). | GATEWAY BASELINE VERIFIED; ADAPTER CONTRACTS NOT WIRED | The NH-036/037 PRs explicitly state that the adapters are not wired into the current gateway inference path. Real provider selection, credentials, request execution, returned usage and billing must be integrated in a later scoped change and tested with mock and authorized live endpoints separately. |
| Credential references and vault | NH-034 CredentialVaultPort (#36), NH-035 development environment adapter (#58). | PORT + DEV ADAPTER ONLY | NH-035 is intentionally forbidden in production, and environment-backed credentials cannot rotate/revoke in place. A production vault and operating controls remain future work. Secrets must never enter database rows, logs, examples or PR text. |
| Sandbox / code execution isolation | NH-038 sandbox contract (#49) and `src/services/sandbox_contract.js`. | CONTRACT ONLY | A contract and validation helper do not prove OS/container isolation, network control, mount/symlink containment, resource quotas or safe artifact handling. Do not call production-grade sandbox execution complete without the actual executor and escape/fault tests. |
| Observability and test infrastructure | NH-016 isolated DB shards (#22); NH-017 CI shards (#19); NH-018 task self-acceptance (#38); NH-019 PR scope guard (#45); NH-040 correlation context (#23); NH-041 metrics contract (#27); NH-043 secret scanner (#28); NH-044 fault server (#31); NH-045 shared fixtures (#32); NH-046 architecture regression scanner (#51). | ENGINEERING CONTROLS IMPLEMENTED / HISTORICALLY VERIFIED | These reduce regression risk, but they are not product modules. Merged status and task evidence must be checked separately from any current main-branch workflow status. |
| M07 independent web interface and full 3D world | README describes a separate React/Vite bootstrap while keeping the legacy UI; design is in `docs/modules/07_User_Interface.md`. | BOOTSTRAP / DESIGN ONLY, FULL EXPERIENCE NOT PROVEN | No evidence here establishes a complete resident journey, fully integrated M04/M06 flows or finished 3D world. Do not report the product UI as complete from the React bootstrap alone. |
| Production authentication, cloud/local provider operation, real Knowledge Ball calls | README's executable-status notes and the adapter/credential PR known limitations. | UNVERIFIED IN REAL ENVIRONMENT | Requires an approved staging environment, non-production credentials, explicit provider/version, safe cost limits, and logged success/failure/timeout reconciliation. No secret value may be committed. |
| HPA recovery/awakening, succession and complete autonomous life loop | V3 system/module specs and the current owner-directed sequence. | NOT COMPLETE IN THIS BASELINE / OWNER-DEPENDENT | Do not advertise HPA succession, full autonomous cognition or the full P5 life loop as implemented merely because profiles, goals, schedules and checkpoints exist. |

## 4. Confirmed gaps and required next actions

### P0 — Preserve the runtime acceptance gate on future changes

NH-001 PR #17 is merged at `4d3986fc507cceb803b7b6670271e53ad9cd20e9`. Its final-head Task Acceptance passed, and the P0-P1 CI run on the merge commit passed. Future changes must preserve the full migration, replacement-audit, `npm run check`, and `npm test` gates; do not create a parallel runtime implementation.

### P1 — Build the actual cross-product execution path

NH-005/006/007/009/010/011/013 define boundaries, safety behavior and readiness semantics. A separately scoped implementation still needs to connect the NewHumans adapter/dispatcher to the authoritative Knowledge Ball API, preserve idempotency across transport retries, persist and reconcile unknown outcomes, and ensure the local frozen Economy cannot be used as a silent fallback. This is an integration project, not documentation closure.

### P1 — Wire model adapters and production credential storage

Cloud/local model adapters and CredentialVault abstractions currently provide reusable contracts and bounded implementations. The existing gateway must be explicitly wired to the intended adapter interfaces; provider-specific credentials must be held by a production-safe vault; usage receipts must remain reconciled with the M05 accounting authority. Test doubles must be visibly labelled.

### P1 — Prove full M04 user journeys

The relational data slices and schemas are not the same as a complete collaboration product. API/UI workflow acceptance should cover identity and world scope, directories/ability evidence, invitations/messages/receipts, two-party relationships, object version publication, space membership, contract version acceptance/delivery/disputes, and organization membership/role history. Preserve module ownership and immutable evidence.

### P2 — Complete the front end and real external verification

The web bootstrap is not the full product experience. A release needs an agreed UI slice connected to implemented APIs, plus separately recorded live provider/Knowledge Ball checks. Full 3D world completion remains beyond what the current repository evidence proves.

## 5. Validation and governance delta

The repository's required software gate is defined in `package.json` and `.github/workflows/ci.yml`:

- `npm run check`: JavaScript syntax, migration-name policy, JSON Schemas and external-authority dependency guard.
- `npm run migrate`: migration policy and PostgreSQL 16 database migrations.
- `npm test`: complete unit suite and isolated integration suite, including serial/parallel manifest equivalence and cleanup.
- PR acceptance: `scripts/check-pr-scope.js`, `scripts/check-replacement-audit.js`, and `scripts/check-task-acceptance.js`.
- Final acceptance must replace `Merge-SHA: PENDING` with the exact GitHub merge commit SHA and pass post-merge validation.

The GitHub branch endpoint reported `main` as unprotected on the audit baseline. The existing repository issue [#4](https://github.com/NewHumans-Lab/NewHumans/issues/4) asks for branch protection and a required P0-P1 CI check; its closure is an administrative control-plane gap, not an application-code change. PRs should still follow the documented gate even while that setting remains unenforced.

## 6. Explicit non-claims

This delta report does **not** claim that:

- a real Knowledge Ball deployment is connected;
- a live cloud or local model provider has been exercised;
- the development CredentialVault is safe for production;
- the sandbox contract provides OS-level isolation;
- PR #17's final runtime gate is closed;
- M03 or autonomous cognition is implemented despite the current deferral;
- all M04 data slices constitute the completed collaboration product;
- the React bootstrap constitutes the complete UI/3D world;
- the merge-commit P0-P1 CI and final-head Task Acceptance passed for NH-001; this does not establish a complete product release.

## 7. Acceptance

- The document maps material design domains to exact current implementation evidence and an explicit status.
- It separates complete task slices from end-to-end functionality, deferred scope and environment-dependent claims.
- It lists actionable next steps without inventing the M03 provider choice or modifying Knowledge Ball.
- It records the source baseline and the limits of CI evidence.
- No runtime, schema, database, gateway, or Knowledge Ball implementation is changed by NH-048.
