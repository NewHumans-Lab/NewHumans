# NH-047 Cross-Module Integration Readiness Matrix

Status: **BASELINE AUDIT RECORDED; PRODUCT RELEASE NOT CLEARED**  
Baseline: `main@2dcba7d6b4e35bb2456f3ab3404b080a1b6d5388` (2026-10-09)  
Scope: Evidence-based readiness and release gates across M01–M07 and the NewHumans ↔ Knowledge Ball boundary. This document does not implement a second provider, alter runtime semantics, or modify Knowledge Ball.

## 1. Status vocabulary

- **MERGED / HISTORICALLY VERIFIED** — the task is merged and its task/CI record reports passing checks. This is not a claim that the latest main commit has a fresh green run.
- **CONTRACT / DATA SLICE ONLY** — a contract, schema, adapter shell, or module-owned data slice exists, but end-to-end wiring is not proved.
- **BLOCKED ON REQUIRED GATE** — code exists, but the task's stated final acceptance gate has not been shown to pass on the current base.
- **INTENTIONALLY DEFERRED** — the current owner-directed sequence explicitly forbids implementation until a dependency/decision is resolved.
- **UNVERIFIED EXTERNAL** — no evidence in this repository proves a live remote endpoint or production credential path was exercised.

A green unit test or a merged data migration must not be promoted to a stronger status than the evidence supports.

## 2. Cross-module acceptance matrix

| Slice | Current evidence | Status | What is still required before claiming the complete product flow |
| --- | --- | --- | --- |
| M01 identity, world isolation, action/event core and the minimum ledger/usage vertical slice | P0/P1 implementation and hardening PRs; integration tests include `tests/integration/p0p1.test.js`, `p1_1_hardening.test.js`, `p1_4_contract_closure.test.js`, and `p1_4_billing_immutability.test.js`. | MERGED / HISTORICALLY VERIFIED | Preserve the full migration and `npm test` gate after changes. This does not establish production identity verification, which is explicitly not simulated by development bootstrap. |
| M02 runtime kernel and continuous control plane | P3-A / P3-B implementation is present on main; `tests/integration/p3a_runtime.test.js`, `p3a_runtime_authority.test.js`, `p3b_runtime_authority.test.js`, and `p3b_runtime_control.test.js`. PR #17 is still open and says its final rebased head must pass the complete PostgreSQL 16 gate. | BLOCKED ON REQUIRED GATE | Rebase the existing runtime-hardening work onto current main, resolve every regression, pass migrations, replacement audit, `npm run check` and the complete `npm test` gate, write back the real merge SHA, then verify the post-merge main run. Do not create a parallel runtime implementation. |
| M03 Knowledge Ball authority boundary | NH-002 ADR plus NH-005 EconomyPort, NH-006 MemoryPort, NH-007 KnowledgePort, NH-008 error model, NH-009 retry/idempotency, NH-010 readiness and NH-011 Saga protocol. | CONTRACT / DATA SLICE ONLY | A live Knowledge Ball endpoint, durable authority-side behavior, authentication and production connection have not been demonstrated by these NewHumans-side contracts alone. Keep any M03-dependent cognition fail-closed. |
| Cross-product contract funding, escrow and settlement | NH-011 defines an executable reference protocol and explicit recovery semantics. Its own limitation states that full Saga persistence tables and transport wiring are outside the task. | CONTRACT ONLY | Implement a separately scoped persistence/dispatcher/callback/reconciliation slice before claiming that cross-product money movement is running end to end. Preserve stable business-attempt identity, query-before-replay and no shadow ledger. |
| M04 Directory, Messaging and Relationships | Merged slices NH-021 (#37), NH-022 (#46), NH-023 (#53), and schemas including NH-028/029/030. Corresponding integration tests are in the M04 test files. | MERGED DATA SLICES / END-TO-END NOT PROVEN | A database slice being verified does not prove the public HTTP/UI workflow is wired across all M04 entities. Run the complete suite after composition changes and add scenario tests when API-level composition is implemented. |
| M04 WorldObject, Space, Contract and Organization | Merged data slices NH-024 (#55), NH-025 (#57), NH-026 (#56), NH-027 (#59), plus NH-032/033 schemas. Test files include `m04_world_objects.test.js`, `m04_space_data.test.js`, `m04_contract_data.test.js` and `m04_organization_data.test.js`. | MERGED DATA SLICES / END-TO-END NOT PROVEN | Ensure dependency constraints remain aligned after each merge; test cross-entity workflows, not merely each module's isolated persistence. No NewHumans-owned wallet or escrow authority may be introduced. |
| M06 gateway and usage accounting | Minimum M06 gateway tests are present in `m06_gateway.test.js` and `m06_conformance.test.js`; cloud/local adapter contracts exist as NH-036/037. | GATEWAY BASELINE VERIFIED; ADAPTER WIRING INCOMPLETE | The cloud/local adapter task records explicitly say they are not wired into the existing gateway inference path. Add a separate integration task with mocked-provider acceptance, then deliberately run a real provider check without confusing mock evidence with production verification. |
| Credentials and sandbox execution | NH-034 defines CredentialVaultPort; NH-035 adds an environment-backed development adapter. NH-038 defines a sandbox execution contract. | CONTRACT / DEVELOPMENT ADAPTER ONLY | NH-035 must remain forbidden in production. A sandbox contract is not proof of OS-level process isolation. Production secret storage, rotation/revocation and real executor isolation require separately accepted implementations. |
| M07 interface and full 3D world | README describes an independent React bootstrap while retaining the legacy UI. The system/module documents define a much larger experience. | NOT COMPLETE | A bootstrap, contract, or design document does not prove the user-facing lifecycle, social workflows, or 3D world is implemented. Acceptance must cover actual user paths and the chosen product UI. |
| External services / real endpoints | Repository records distinguish test doubles and contracts from real model or Knowledge Ball calls. | UNVERIFIED EXTERNAL | Use an explicitly authorized staging endpoint and test identity; record provider, model/endpoint version, result, cost, failure behavior and reconciliation evidence. Do not place secret values in Git, database fixtures, PR comments or logs. |

## 3. Release-blocking rules

1. **One writable authority per domain.** NewHumans owns identity/lifecycle/goals/relationships according to the current boundary; Knowledge Ball remains the sole writable authority for Economy/Energy, durable Memory and Knowledge. Local fallback writes are forbidden.
2. **M03 dependency must fail closed.** The owner-directed sequence in `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` explicitly defers the provider decision. No test may make autonomous cognition appear production-ready by injecting a substitute context path.
3. **No distributed-transaction fiction.** Cross-product writes require local ACID, stable idempotency keys, durable outcomes and reconciliation. An HTTP request to Knowledge Ball cannot be treated as part of the NewHumans PostgreSQL transaction.
4. **Task acceptance has two phases.** Before merge, the PR must contain concrete Task-ID, Scope, Tests, Self-Review, Known-Limitations and `Merge-SHA: PENDING`; after merge, the exact GitHub merge SHA must be written back and the final acceptance workflow must pass.
5. **Latest-base CI is the gate.** Historical green CI on an older parent is not current acceptance. Rebase, repeat checks, merge only after a green final head, then verify the main-branch run and content.
6. **External integration claims require external evidence.** Contract tests and fake providers are useful but must remain labelled as mocks.

## 4. Required repository gate

The authoritative CI entry point is the repository's current `package.json` test chain:

- `npm run check` — syntax, migration namespace, schemas and external-authority guard.
- `npm run migrate` — PostgreSQL migration validation and execution.
- `npm test` — checks, complete unit suite, serial/parallel integration equivalence and isolated database cleanup.

A task that touches only documentation still must pass the repository-required PR workflow. A product release additionally needs the relevant runtime and external integration evidence; documentation CI alone cannot supply it.

## 5. Baseline caveats and follow-up

- At the time this matrix was written, current main was `2dcba7d6b4e35bb2456f3ab3404b080a1b6d5388`; the latest combined-status endpoint returned no individual status entries for that SHA. This document therefore relies on task-level historical acceptance records where cited and does not fabricate a fresh all-green main CI result.
- PR #17, NH-001 runtime hardening, remained open at this baseline; its description explicitly required a fresh latest-base green run before acceptance.
- The original NH-047 task-card scope was not present in the repository or discoverable among its PRs/issues. This file records a conservative integration-readiness deliverable from the observable gaps; it does not claim to recover an unavailable prior task description.
- Knowledge Ball internals are outside this task. No production provider, Knowledge Ball deployment, real credential, or product UI is altered by this document.

## 6. Acceptance

- The matrix distinguishes merged evidence from interface-only work, deferred scope, and unverified external integration.
- Each incomplete or blocked vertical slice has an explicit release condition.
- Links and paths point to repository evidence rather than inferred implementation.
- No change to runtime, database schema, product authority or Knowledge Ball is included.
- Full repository CI must pass on the PR head before merge; final acceptance must record the exact merge SHA.
