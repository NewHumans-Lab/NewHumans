# P3-B — M02 Continuous Runtime Control Plane

Status: **IMPLEMENTED; VERIFICATION PENDING PR FINAL-HEAD CI**  
Protocol baseline: `nh.v3.0`  
Owner sequencing: M03 / Knowledge Ball remains deliberately deferred.

## Purpose

P3-B completes the independently implementable M02 continuous-runtime control plane on top of the verified P3-A kernel. It does not invent an M03 implementation and does not claim full P3 autonomous cognition.

The design rule for this slice is:

> Runtime control may become complete before cognition becomes available. Any operation that would enable Agent cognition must fail closed while the authoritative M03 context provider is absent.

## Implemented control-plane authority

### Lifecycle and Energy coordination

- `REGISTERED`, `ACTIVE`, `DORMANT` and existing lifecycle state remain owned by M02.
- Lifecycle transitions write append-only `runtime.lifecycle_transition_events`.
- First activation still uses the M05 ≥100 E rule and exact 1 E UTC-day fee.
- Ordinary resume after a prior activation does not reapply the 100 E first-activation minimum.
- Same-day resume does not charge a second daily fee.
- Cross-day active reconciliation charges the current UTC-day fee exactly once or moves an unfunded runtime to DORMANT.
- Current eligibility reads M05 wallet/fee state at evaluation time; M02 does not cache Energy as a payment authority.
- Post-fee available Energy <100 E permits only otherwise-authorized inbound response; ≥100 E is required for proactive task seeking; ≤0 E cannot act.

### Trusted scheduler initiation

P1 temporarily required the activity subject itself to initiate `firstActivation` and `chargeDailyActivityFee`. That restriction cannot support a sleeping Agent whose authorized schedule is executed by the platform.

P3-B replaces it with one rule:

- the activity subject itself may initiate its fee;
- an ACTIVE SYSTEM Entity in the same world may initiate the fee on behalf of the runtime scheduler;
- unrelated HUMAN/AGENT/ORGANIZATION Entities cannot charge another subject.

M05 remains the sole ledger authority. M02 never writes wallet balances or monetary journals directly.

### Restrictions and model state

- `OWNER_PAUSE`, `NO_BUDGET`, `QUARANTINE`, and `WORLD_SUSPENSION` have an explicit SYSTEM policy-mutation path.
- Enabling a blocking restriction on an ACTIVE runtime moves it to DORMANT after quiescence.
- Clearing a restriction does **not** auto-wake the Agent.
- Model outage/recovery does not clear unrelated owner/policy restrictions.
- PostgreSQL prevents an ACTIVE lifecycle row from retaining categorical blocking restrictions, including `M03_CONTEXT_UNAVAILABLE`.

### Goals

- Existing M02 goals remain the single mutable current record.
- Every create/update has append-only `runtime.goal_revisions` evidence.
- Updates use optimistic `expectedVersion` fencing and must advance exactly one version.
- Legal goal-state transitions are enforced.
- Terminal goals are not rewritten to claim a different outcome; a new goal is required instead.
- OWNER_DIRECTIVE and CONTRACT_OBLIGATION mutation authorization remains deferred to their owning integrations rather than guessed in M02.

### Traits

- `runtime.trait_states` is the one current trait authority.
- Values use integer parts-per-million (`0..1,000,000`) rather than floating point.
- Trait class is immutable for a key; BIRTH traits are immutable after creation.
- `runtime.trait_updates` is append-only evidence.
- A deferred PostgreSQL constraint requires every current trait-state version to have exactly one matching update record, preventing direct-SQL silent mutation.

### Scheduling and recovery

- `runtime.scheduled_actions` stores immutable schedule terms: action kind, due time, timezone, missed policy, budget, priority and dedupe key.
- `WAKE` and `AUTONOMOUS_TURN` are different action kinds and deliberately have different single execution paths.
- WAKE uses one atomic SYSTEM scheduler path and is never claimed through the ordinary runtime-lease path.
- AUTONOMOUS_TURN uses the current runtime lease and is fenced by `lease_epoch`.
- A current Worker with a strictly higher lease epoch may safely take over an older `CLAIMED` autonomous schedule after Worker failure.
- The old Worker cannot complete work after takeover.
- Schedule status transitions and immutable terms are enforced by PostgreSQL.

## M03 dependency boundary

Production runtime profiles still begin with `M03_CONTEXT_UNAVAILABLE` while the Knowledge Ball decision is deferred.

P3-B therefore intentionally preserves these rules:

- runtime resume that would enable cognition fails with `M03_CONTEXT_UNAVAILABLE` before a new daily fee is charged;
- scheduled WAKE is blocked before fee charge while M03 is unavailable;
- AUTONOMOUS_TURN cannot become an alternate no-memory inference path;
- the existing `runtime.request_turn` dependency gate remains;
- there is no production API/UI for removing the M03 dependency flag.

Integration tests may remove the flag directly inside an isolated test world as a **controlled dependency stub** to exercise lifecycle and economic behavior. That SQL is test fixture setup only; it is not a production route and is not exposed through HTTP.

## Frontend / HTTP alignment

The development console is now labeled P3-B and uses the same backend contracts:

- Agent creation also registers its M02 runtime profile;
- gateway setup also creates a model manifest and publishes the Agent route;
- runtime state, eligibility, control history, pause and resume are visible through the P3-B APIs;
- direct M05/M06 inference controls remain explicitly labeled infrastructure diagnostics and do not bypass the M03 gate for Agent cognition.

State-changing HTTP operations continue to use the canonical `nh.v3.0` command envelope / Action idempotency chain.

## PERFECT_REPLACEMENT audit

`Replacement-Audit: APPLICABLE`

Superseded paths:

1. P1 activity-fee initiation that required only the subject actor and therefore could not support an authorized dormant-runtime scheduler.
2. A generic schedule-claim path that could also claim WAKE, conflicting with lifecycle quiescence and creating two ways to wake a runtime.
3. Lease-fenced autonomous schedule claims that had no higher-epoch takeover path after Worker failure.
4. Trait current-state writes whose evidence relationship was service-conventional rather than database-authoritative.
5. Mutable schedule terms/status without PostgreSQL transition authority.
6. The P1.4 browser console path that created an AGENT Entity without creating its M02 runtime and did not expose the current M02 control semantics.

Cleanup result:

- fee initiation has one subject-or-trusted-SYSTEM rule;
- WAKE has one scheduler execution path;
- AUTONOMOUS_TURN has one lease-fenced claim path plus strictly higher-epoch recovery of that same claim;
- trait updates and schedule transitions have database authority guards;
- the browser console is aligned to P3-B contracts;
- no fake M03, memoryless Agent cognition path or alternate Personal Overlay is present.

## Design review completed before CI

The review explicitly checked:

- M05 remains the only Energy ledger authority;
- M02 uses current M05 values rather than stale summaries to determine eligibility;
- model recovery cannot clear independent restrictions;
- DORMANT does not infer, search or send merely because inbound delivery exists;
- schedule recovery cannot revive an old Worker epoch;
- current trait/goal state has immutable historical evidence;
- M03 dependency blocking occurs before cognition side effects;
- direct M05/M06 development diagnostics are not represented as Agent autonomous execution.

## Verification gate

Before this file may be changed to VERIFIED, the PR final head must pass:

- repository `PERFECT_REPLACEMENT` audit;
- empty PostgreSQL 16 migration through `013`;
- all JavaScript syntax and JSON Schema compilation checks;
- the complete prior P0/P1/P1.1/P1.2/P1.3/P1.4/P1.4.1/P3-A regression suite;
- P3-B tests for exact 99.999999 / 100 / 101 E activation boundaries;
- same-day and cross-day fee behavior;
- trusted SYSTEM versus unrelated Entity fee authority;
- lifecycle restriction independence and model recovery;
- goal revision/version semantics;
- bounded trait authority and evidence guards;
- schedule missed/block/claim/complete semantics;
- WAKE single-path behavior;
- M03 blocking before fee/provider side effects;
- stale lease rejection and higher-epoch safe claim takeover;
- direct-database authority tests for protected current-state paths.

After the first green implementation head, verification evidence will be written into this document/README. That documentation-only final head must then pass the complete CI again.

## Not claimed

- full P3 autonomous cognition or memory continuity verification;
- any M03 / Knowledge Ball implementation, adoption or migration decision;
- Personal Overlay or memory retrieval;
- M04 messaging/contracts semantics;
- P5 birth/clone/HPA recovery/awakening;
- production authentication/KMS;
- real cloud/local model compatibility beyond the previously controlled M06 protocol fixture;
- 72-hour autonomous exercise or 30-real-day P6 evidence.

Once P3-B is verified, further completion of the P3 autonomous-turn chain requires the owner decision on M03. Development must stop at that boundary rather than invent a substitute context provider.
