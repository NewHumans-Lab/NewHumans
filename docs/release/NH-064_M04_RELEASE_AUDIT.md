# NH-064 — M04 Release Readiness Audit

**Audit date:** 2026-10-21  
**Decision:** **NO-GO for public production release.** Some domain services and Saga infrastructure are merged and CI-verified, but protected HTTP integration, live identity/economy dependencies, and end-to-end release evidence remain incomplete.

## 1. Evidence-backed implementation status

| Area | Current evidence | Release interpretation |
|---|---|---|
| Durable Saga / Outbox / Inbox | PR #74, merge SHA from repository history | Durable workflow primitives exist; this alone does not prove a live financial integration. |
| Contract activation and settlement Saga integration | PR #75 | Orchestration exists; settlement remains dependent on authoritative escrow evidence. |
| Durable Outbox worker and retry/reconciliation | PR #76 | Retry/reconciliation infrastructure exists; unknown outcomes must be reconciled, not guessed. |
| Supervised Saga worker runtime | PR #77 | Worker runtime exists; external provider correctness remains separate. |
| Readiness/design delta | PR #78 | Documents readiness and design gaps. |
| Settlement precondition guard | PR #79, merge SHA `40cb4948` (short SHA) | Guarded settlement preconditions are present; not proof of a live provider. |
| Contract proposal/version/acceptance | PR #80, merge SHA `28bff147` (short SHA) | Service-level contract lifecycle exists. |
| Delivery/review/rework/dispute opening | PR #81, merge SHA `a650af38` (short SHA) | Dispute opening exists; adjudication was a separate missing operation. |
| Trusted Knowledge Ball principal binding | PR #82, merge SHA `b0b03f2d` (short SHA) | Binding service/schema exists; live identity-provider verification is not established by CI. |
| EconomyPort v2 / authoritative escrow snapshot | PR #83, merge SHA `ecf8c488ea9e75beea2fa253609d40171614fdef` | Interface and snapshot contract exist; atomic compare-and-distribute in a real KB adapter is not verified. |
| Trusted dispute adjudication | PR #86, merge SHA `6fffbbc626a236e8a72326b23d1c105346c57b21` | Service-level adjudication is merged; no public HTTP route is exposed by this change. |

Short SHAs above are identifiers for navigation, not substitutes for the full merge commit in the repository. CI success proves the tested repository behavior under CI fixtures; it does not prove live Knowledge Ball provider behavior.

## 2. Lifecycle coverage and boundaries

### Present at service/orchestration level
- Contract proposal/version/acceptance and delivery/review/rework flows.
- Dispute opening and a trusted-adjudicator service operation.
- Durable Saga, Outbox/Inbox, retry and reconciliation primitives.
- Trusted principal-binding schema/service and EconomyPort v2 contract.
- Settlement precondition checks and an authoritative escrow snapshot contract.

### Not established as production-ready
- Public M04 HTTP routes are not yet wired through a trusted production request context.
- The current HTTP actor context is a development adapter, not production authentication.
- A live Knowledge Ball identity provider and compatible EconomyPort v2 adapter have not been verified end-to-end.
- A balance snapshot is **not** a reservation. The provider must atomically compare expected balance and resource version in the same authoritative transaction that distributes funds.
- Full public API lifecycle E2E evidence, including real provider settlement receipts and unknown-outcome reconciliation, is missing.
- Dispute adjudication deliberately leaves the contract DISPUTED. Resolution is not an instruction to transfer funds; settlement/cancellation must remain a separate guarded Saga path.

## 3. Hard release gates

### Gate A — Scope registry bootstrap and protected routes
**Status: BLOCKED — issue #84.**

The PR scope checker protects `src/http/server.js` and `.github/task-scopes/**`. The initial registry is absent on `main`, and the existing hard-coded NH-019 exception is scoped to its own task/branch and does not authorize the registry. Do not reuse NH-019, impersonate NH-001, rely on PR-body paths for protected files, or weaken the guard.

**Exit evidence:** one-time owner/maintainer-authorized bootstrap reviewed and merged; adversarial tests show unauthorized registry edits and widened scopes are rejected; then a normal base-registered NH-062 scope permits only exact non-financial M04 route paths.

### Gate B — Trusted production request identity
**Status: NOT VERIFIED.**

**Exit evidence:** HTTP request identity is derived from the production authentication boundary; clients cannot choose arbitrary actor/principal IDs; authorization is rechecked against the current world, contract and role; tests cover spoofing, revoked bindings, cross-world access, and missing identity.

### Gate C — Live Knowledge Ball identity and EconomyPort
**Status: NOT VERIFIED.**

**Exit evidence:** live-compatible identity proof verification and principal resolution are exercised in an integration environment; the v2 adapter implements the complete port without a local wallet/ledger fallback; failure, timeout, duplicate replay, and unknown outcomes are mapped to explicit fail-closed behavior.

### Gate D — Atomic settlement and authoritative evidence
**Status: NOT VERIFIED.**

**Exit evidence:** authoritative provider performs expected-balance **and** expected-resource-version comparison atomically with distribution; stale snapshots cause no transfer; retries reuse the same idempotency key and payload digest; success persists a provider settlement receipt and new resource version; unknown outcomes are reconciled before any new attempt.

### Gate E — Full lifecycle E2E and operational readiness
**Status: NOT COMPLETE.**

**Exit evidence:** automated tests cover proposal → acceptance → delivery → review/rework → dispute → adjudication → guarded settlement, with concurrent changes, duplicate commands, provider timeouts, unknown outcomes, stale escrow versions, and negative cases. Operational alerts, reconciliation ownership, rollback/compensation behavior, and release runbook are reviewed.

## 4. Route exposure policy

| Route class | Decision | Condition |
|---|---|---|
| Non-financial M04 proposal/version/acceptance/delivery/review/dispute routes | **Not yet exposed** | Resolve #84; register exact scope; wire trusted request context; add API contract and E2E tests. |
| Principal-binding administrative routes | **Closed by default** | Trusted identity-verification port, strict authorization, audit trail and revocation tests must be live-verified. |
| Activation, escrow, settlement, distribution, or other financial mutation routes | **CLOSED** | All of Gates B–E must pass, including authoritative atomic provider behavior. |

## 5. Architecture invariants

1. Knowledge Ball remains an independent product; NewHumans consumes its supported boundary and does not reimplement its internals.
2. NewHumans must not maintain a second writable economy ledger or synthesize local credits/debits when the provider is unavailable.
3. A client-supplied `principal_ref`, actor ID, escrow balance, receipt, or resource version is not authoritative merely because it is syntactically valid.
4. A contract price is a negotiated term, not evidence of the current escrow balance.
5. A snapshot is not a reservation; settlement must use an atomic expected-balance/version check at the authoritative provider.
6. Timeout and unknown outcome are distinct from definitive failure. Do not release funds, create a replacement transfer, or change an idempotency payload until reconciliation establishes the prior operation's outcome.
7. Adjudication persists resolution evidence but does not move funds. Settlement remains a separately authorized Saga operation.

## 6. Go/no-go checklist

- [ ] #84 bootstrap merged through an explicitly authorized, auditable path.
- [ ] NH-062 exact task scope registered on base.
- [ ] Non-financial API routes use trusted request identity and pass adversarial authorization tests.
- [ ] Live KB identity binding and EconomyPort v2 adapter verified.
- [ ] Atomic expected-balance/resource-version distribution demonstrated against the authoritative provider.
- [ ] Provider receipts, idempotency, timeout, unknown-outcome reconciliation, and stale-version behavior pass E2E tests.
- [ ] Full lifecycle and operational runbook reviewed.
- [ ] Final PR records full merge SHA and CI evidence.

**Current decision remains NO-GO** until the above evidence is recorded. Documentation and CI-only evidence must not be represented as live-provider or production verification.
