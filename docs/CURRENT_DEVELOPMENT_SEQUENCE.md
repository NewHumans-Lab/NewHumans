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

## Current authorized slice: P3-A

P3-A may implement only M02-owned authoritative foundations:

- Agent runtime profiles;
- lifecycle state authority;
- immutable model manifests and versioned model routes;
- runtime leases and epoch fencing;
- versioned checkpoints;
- goals and goal dependencies;
- dependency visibility showing that M03-backed autonomous cognition is unavailable.

P3-A must not claim full P3 completion. In particular, the complete autonomous life turn described by M02 remains blocked because its context-building step requires M03.

## Acceptance consequence

A green test that runs inference without M03 context is **not** an acceptable shortcut. Such a path is a design defect because it would become a second cognition path that later has to be removed.

The required invariant during this override is:

**M02 foundation may advance; M03 semantics may not be guessed.**

This file takes precedence over generic phase chronology only. V3 data ownership, interface boundaries, Energy rules, identity rules, and M03 responsibilities remain unchanged.
