# Current owner-directed development sequence

Status: **ACTIVE sequencing override**  
Date: 2026-09-16  
Scope: development order only; this does not redefine V3 module ownership or remove M03 from the product architecture.

## Owner direction

Knowledge Ball / M03 is intentionally deferred. Leave its implementation and adoption decision untouched until the later owner decision on whether to reuse the existing Knowledge Ball, partially adapt it, or rebuild it.

The generic V3 phase table remains the architectural integration target, but its chronological order is overridden as follows while this file is ACTIVE:

1. Keep the verified P0/P1 foundation as the base.
2. Proceed with M02 slices that are independently correct without choosing an M03 implementation.
3. Do **not** create a temporary Knowledge Ball, fake memory service, local substitute Personal Overlay, or a production "memoryless Agent" cognition path.
4. Any autonomous turn or other behavior that requires M03 context must fail closed with an explicit dependency block until an authoritative M03 provider is adopted.
5. Continue later modules only where their design can be implemented without inventing M03 semantics. If a next slice cannot be correct without M03, stop before implementation and return for owner discussion.
6. Decide the final Knowledge Ball path later; integration must attach through the single M03 contract rather than replacing a temporary alternate cognition path.

## Completed slice: P3-A

P3-A established the M02-owned runtime kernel without an M03 substitute:

- Agent runtime profiles;
- lifecycle state authority;
- immutable model manifests and versioned model routes;
- runtime leases and epoch fencing;
- versioned checkpoints;
- goals and goal dependencies;
- explicit dependency visibility showing that M03-backed autonomous cognition is unavailable.

P3-A is merged and verified. It does not claim the complete P3 autonomous life loop.

## Current authorized slice: P3-B

P3-B may complete M02 continuous-runtime control-plane behavior that remains semantically correct without selecting an M03 implementation:

- REGISTERED / ACTIVE / DORMANT lifecycle orchestration and immutable transition evidence;
- exact M05 first-activation and daily-fee coordination, including trusted SYSTEM scheduler initiation;
- current execution eligibility derived from authoritative lifecycle, current M05 wallet/fee state, route/model availability and independent restriction flags;
- post-fee 0 / 100 E activity and proactive-task thresholds;
- versioned goal mutation history;
- authoritative bounded trait state with append-only update evidence;
- scheduled WAKE and AUTONOMOUS_TURN control records, due/missed policy, deduplication, lease fencing and safe higher-epoch claim takeover;
- cross-day reconciliation and model/policy restriction handling;
- HTTP, machine schemas and development-console visibility for the same control-plane semantics.

P3-B must preserve the following dependency boundary:

- `M03_CONTEXT_UNAVAILABLE` remains present in production runtime state while M03 is deferred;
- a real runtime resume that would enable Agent cognition must fail before charging a new activity fee or invoking M06 while that dependency remains unresolved;
- test-only dependency stubs may exercise the lifecycle/economic state machine in isolated test worlds, but no production API or UI may remove the M03 gate;
- direct M05/M06 development diagnostics are infrastructure tests only and are not an alternate Agent cognition path.

## P3 completion boundary

After P3-B is verified, all independently implementable M02 continuous-runtime control behavior is considered available. **Full P3 remains incomplete by design** until an authoritative M03 provider is adopted and the single autonomous-turn chain can be integrated and verified:

`M02 eligibility → M05 budget → M03 context retrieval → M06 registered route → M01 authorized action → checkpoint/schedule continuation`.

Do not implement a substitute path merely to make this chain green. When development reaches this boundary, stop and return for the owner decision on the Knowledge Ball.

## Acceptance consequence

A green test that runs Agent inference without M03 context is **not** an acceptable shortcut. Such a path is a design defect because it would become a second cognition path that later has to be removed.

The required invariant during this override is:

**M02 control plane may advance; M03 semantics may not be guessed.**

This file takes precedence over generic phase chronology only. V3 data ownership, interface boundaries, Energy rules, identity rules, and M03 responsibilities remain unchanged.
