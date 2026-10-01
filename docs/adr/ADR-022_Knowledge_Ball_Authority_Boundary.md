# ADR-022 — Knowledge Ball is the sole Economy, Memory, and Knowledge authority

Status: **Accepted**  
Task: **NH-002**  
Decision date: **2026-10-01**  
Scope: architecture and data-authority boundary only  
Migration state: **BOUNDARY_ACCEPTED / EXECUTABLE_REPLACEMENT_PENDING**

## 1. Context

NewHumans V3 was written before the final owner decision to keep Knowledge Ball as an independent product that can also be embedded into NewHumans. V3 therefore split authority across an internal M03 Knowledge Ball and an internal M05 Economy, while M02 documentation also described NewHumans as retaining long-term memory and Personal Overlay state.

The current owner decision supersedes that ownership split:

- the existing Knowledge Ball remains an independent product;
- Knowledge Ball is the single writable authority for **Economy + Memory + Knowledge**;
- NewHumans must not create or retain a second independently writable authority for those domains;
- NewHumans remains authoritative for **Identity + Goals + Lifecycle + Relationships**;
- NewHumans may display, reference, index, cache, or project Knowledge Ball data only when that copy cannot become a competing source of truth;
- Knowledge Ball internals are outside the scope of this task.

This ADR resolves the authority boundary only. It does not claim that the current repository has already completed the executable migration. Existing NewHumans M05 write paths are therefore legacy implementation pending versioned replacement, not the target architecture.

## 2. Decision

### 2.1 Authoritative ownership

| Domain | Writable authority | NewHumans owned / allowed | NewHumans forbidden |
| --- | --- | --- | --- |
| Identity | **NewHumans** | Own Entity identity, authentication binding, delegation, HPA binding, identity status and authorization roots | Let Knowledge Ball mint, replace, merge or split NewHumans Entity identity |
| Goals | **NewHumans** | Own current goal state, dependencies, versions and goal lifecycle | Let KB memory/knowledge writes directly mutate authoritative goal state |
| Lifecycle | **NewHumans** | Own REGISTERED/ACTIVE/DORMANT/TERMINATED, runtime eligibility, leases, wake/dormancy and recovery control state | Treat KB memory/knowledge state as lifecycle authority |
| Relationships | **NewHumans** | Own authoritative relationship records, confirmations, revocations and relationship state | Treat a KB assertion, memory or belief as an authoritative relationship mutation |
| Economy | **Knowledge Ball** | Read/display authoritative Economy state through the KB contract; request authorized operations; retain non-authoritative request/result references | Maintain a second writable wallet, balance, ledger, reservation, escrow, settlement, issuance or fiscal authority |
| Memory | **Knowledge Ball** | Retrieve long-term memory; retain KB object/version references; M02 may keep short-lived runtime working state and checkpoint metadata | Maintain a second writable long-term memory store, Personal Overlay authority, or local-write-then-sync fallback |
| Knowledge | **Knowledge Ball** | Query/reference/render knowledge and submit through the KB contract | Maintain a second writable public knowledge graph, evidence verdict, personal knowledge state, challenge/review authority or canonical claim store |

This ADR does not reassign domains not listed above. Existing ownership of permissions, contracts, messages, model/tool execution and presentation remains unchanged unless a later ADR explicitly changes it.

### 2.2 NewHumans owned

NewHumans remains authoritative for:

- world Entity identity, authentication, HPA/proxy binding, delegation and identity status;
- Agent lifecycle and runtime control state;
- goals, goal dependencies and goal state history;
- authoritative relationships and their confirmation/revocation state;
- short-lived runtime/checkpoint state required to resume execution.

Runtime/checkpoint state must not become a disguised long-term memory authority. Checkpoints may reference Knowledge Ball memory/knowledge versions and returned context, but they must not become an independently writable autobiographical or semantic history.

### 2.3 NewHumans referenced

NewHumans may retain **non-authoritative references or derived read models** of Knowledge Ball state, including:

- Economy: account/wallet reference, displayed balance snapshot, available-balance snapshot, quote/reservation/settlement result reference, authority version/cursor;
- Memory: memory ID, snapshot/version, retrieval result reference, provenance and context reference;
- Knowledge: node/claim/evidence/challenge/personal-state ID, version, provenance and query/index result;
- integration evidence: command ID, idempotency key, operation status and verified Knowledge Ball receipt.

Every such reference/read model must satisfy all of the following:

1. it records Knowledge Ball as the authority source;
2. it is mechanically rebuildable from Knowledge Ball or disposable without changing authoritative truth;
3. it cannot accept independent business writes for Economy, Memory or Knowledge;
4. stale state is detectable;
5. a critical decision requiring current Economy/Memory/Knowledge state revalidates against the Knowledge Ball authority or fails closed;
6. a conflict never resolves by overwriting Knowledge Ball from the NewHumans copy.

The Energy balance shown in a NewHumans account is therefore a view of the Knowledge Ball balance, not a separate NewHumans balance.

### 2.4 NewHumans forbidden

The following patterns are forbidden after this ADR:

1. a local writable Energy wallet/balance that can diverge from Knowledge Ball;
2. a local authoritative journal/posting/reservation/escrow/settlement path parallel to Knowledge Ball Economy;
3. a local writable long-term memory table, Personal Overlay, belief/memory authority or model-specific memory silo;
4. a second writable public knowledge graph, canonical claim store, evidence verdict, challenge state or personal knowledge authority;
5. bidirectional synchronization where both systems accept authoritative writes for the same fact;
6. last-write-wins, timestamp-wins or manual conflict picking between two writable authorities;
7. a local-write-then-sync production fallback when Knowledge Ball is unavailable;
8. using M01 events, M02 checkpoints, M04 messages/relationships, M06 usage receipts or M07 UI state as substitute Economy/Memory/Knowledge authority;
9. copying Knowledge Ball private tables into NewHumans to obtain local write capability;
10. direct coupling to Knowledge Ball private database tables that bypasses its stable integration contract;
11. calling the old NewHumans M05/M03 path authoritative merely because it still exists during migration.

A compatibility layer is allowed only when it has exactly one authoritative write destination: Knowledge Ball.

## 3. Identity unification without authority duplication

Knowledge Ball may support its own authentication adapter and local subject/account identifier when used standalone. That standalone identifier is not a second NewHumans Entity identity.

When Knowledge Ball is embedded into NewHumans:

1. the authoritative NewHumans Entity reference comes from NewHumans;
2. the integration layer maintains a stable, auditable subject binding between that Entity and the Knowledge Ball subject carrying Economy/Memory/Knowledge state;
3. multiple chats, models, devices, workers or reconnects do not create multiple KB authorities for the same NewHumans Entity;
4. mapping changes are explicit, versioned and auditable;
5. names, email addresses, model IDs, text similarity or browser sessions are insufficient to infer identity equivalence;
6. Knowledge Ball standalone identity cannot mutate NewHumans Entity identity facts.

This provides one subject across products by reference, not two systems independently owning the same identity domain.

## 4. Cross-domain operation rule

A workflow that touches both products must preserve one authority per fact.

Examples:

- **Activation:** NewHumans owns lifecycle transition; Knowledge Ball Economy owns fee/balance effects. NewHumans consumes the KB result instead of posting a second local fee journal.
- **Model execution:** M06 owns measured provider/tool usage; Knowledge Ball Economy owns the Energy charge derived from that evidence.
- **Contract settlement:** NewHumans owns contract/relationship state; Knowledge Ball Economy owns escrow and settlement money state.
- **Autonomous turn:** M02 owns lifecycle/goal/turn state; Knowledge Ball Memory/Knowledge supplies authoritative context and receives authorized memory/knowledge submissions.
- **Identity-linked memory:** NewHumans owns the subject identity; Knowledge Ball owns the subject's long-term memory.

Until a concrete cross-system transaction protocol exists, code must fail closed rather than create a temporary second authority to simulate success.

## 5. Failure behavior

When Knowledge Ball is unavailable:

- operations requiring a current Economy read or Economy write fail closed;
- autonomous cognition requiring long-term Memory/Knowledge fails closed;
- NewHumans-only operations that do not require those domains may continue;
- no local Economy/Memory/Knowledge authority is created as a fallback;
- stale read projections may only be used where the product contract explicitly permits stale display and clearly preserves their non-authoritative status.

## 6. Existing repository state

This ADR is a boundary decision, not a migration/deletion task.

The current repository already contains NewHumans-local Economy implementation, including `src/services/economy.js`, Economy migrations/tests, and `nh.v3.0` flows that treat M05 as the local economic authority. Those files are not modified by NH-002. They remain executable historical behavior until a later versioned cutover task replaces, adapts, freezes or retires them.

From acceptance of this ADR onward:

- existing M05 must not be expanded into a permanent authority parallel to Knowledge Ball;
- Memory/Knowledge must not receive a temporary local substitute merely because integration is incomplete;
- Knowledge Ball internals remain untouched by this NewHumans task;
- PR #17 runtime hot files remain outside NH-002 scope.

## 7. Conflict audit against V3 and current repository decisions

The following older statements are superseded only to the extent stated. Unrelated invariants remain in force.

| Existing source | Existing meaning | ADR-022 resolution |
| --- | --- | --- |
| `docs/NewHumans_System_Spec_V3.md` §2 module table | M03 owns knowledge/memory references; M05 owns Energy/economy | **Superseded ownership split.** Knowledge Ball owns Economy + Memory + Knowledge; NewHumans keeps Identity + Goals + Lifecycle + Relationships. |
| `docs/NewHumans_System_Spec_V3.md` §4.1 | NewHumans saves long-term memory and Personal Overlay alongside goals/relationships | **Partially superseded.** Long-term Memory and Personal Overlay authority move to Knowledge Ball; Goals/Relationships/Identity continuity remain NewHumans-owned. |
| `docs/modules/03_Knowledge_Ball.md` §1.2 | real balance is outside Knowledge Ball | **Superseded.** Authoritative Economy/Energy is now a Knowledge Ball domain; identity/lifecycle/goals/relationships remain external NewHumans facts. |
| `docs/modules/03_Knowledge_Ball.md` §2 | world mode receives budget from M05 | **Superseded.** Embedded Knowledge Ball Economy becomes the budget authority. |
| `docs/modules/05_Energy_and_Resources.md` | M05 is authoritative for wallets, journals, reservations, escrow, fees and settlement | **Superseded as target ownership.** Existing accounting semantics may be retained by later design, but the writable authority must be provided by Knowledge Ball. |
| `docs/modules/02_Agent_Life_Runtime.md` | M02/NewHumans context includes long-term memory/Personal Overlay and depends on M05 budget | **Partially superseded.** M02 keeps runtime/lifecycle/goals; long-term Memory moves to Knowledge Ball and Economy dependency resolves to Knowledge Ball. |
| `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` | final Knowledge Ball adoption path is undecided; V3 ownership remains unchanged | **Partially superseded.** Adoption of the existing independent Knowledge Ball as the authoritative provider is now decided. Its prohibition on fake/substitute M03 and fail-closed behavior remains valid. |
| `DECISIONS.md` ADR-003/004/009 | microE precision, balanced journals and append-only economic evidence under local M05 | **Business invariants remain candidates to preserve; local authority implication is superseded.** This ADR does not silently change amount precision or ledger safety rules. |
| `DECISIONS.md` ADR-013 | M05 remains the only money authority | **Superseded in authority location.** Knowledge Ball Economy is the only money authority; M06 still does not own money. |
| `DECISIONS.md` ADR-015/016/018/021 | eligibility, quote/reservation, usage settlement and immutable billing evidence route through M05 | **Economic safety semantics remain; authority endpoint changes in the later integration.** |
| `DECISIONS.md` ADR-001 | core semantic changes require a new protocol version; persisted meaning must not be silently redefined | **Preserved.** NH-002 does not reinterpret existing `nh.v3.0` records or switch runtime behavior. The production authority cutover requires an explicit new/versioned integration contract and migration boundary before it can be declared complete. |

### Conflict-audit result

- **Identity:** retained in NewHumans; no duplicate authority introduced.
- **Goals/Lifecycle:** retained in NewHumans.
- **Relationships:** retained in NewHumans.
- **Memory/Personal Overlay:** old NewHumans ownership wording is superseded.
- **Knowledge:** existing Knowledge Ball direction is retained and strengthened to sole writable authority.
- **Economy/Energy:** old M05 target ownership is superseded; current executable M05 is migration debt, not a second target authority.
- **Development sequencing:** fake/substitute Knowledge Ball paths remain forbidden; only the prior “provider/ownership undecided” statement is superseded.
- **Protocol versioning:** ADR-001 remains binding; no existing `nh.v3.0` persisted meaning is silently changed by this documentation-only task.

There is therefore one target semantic owner for every affected domain, while executable migration remains explicitly outside NH-002.

## 8. Migration constraints for later tasks

Later implementation work must:

1. integrate through a stable, versioned Knowledge Ball Economy/Memory/Knowledge contract;
2. version the NewHumans integration semantics as required by ADR-001 before changing persisted authority meaning;
3. inventory every NewHumans writable Economy and long-term-memory path before enabling the KB write path;
4. define cutover, migration/freeze and rollback boundaries explicitly;
5. never leave both NewHumans and Knowledge Ball writable for the same Economy/Memory/Knowledge fact in normal production operation;
6. preserve idempotency and audit evidence without duplicating monetary effects or memory/knowledge submissions;
7. update tests so they prove NewHumans cannot write authoritative Economy/Memory/Knowledge state locally after cutover;
8. keep fail-closed behavior until the authoritative integration is available;
9. retire or permanently disable superseded local authority paths before executable replacement is declared complete.

## 9. Acceptance invariants

NH-002 is accepted only if all of the following hold:

- [x] **Owned:** Knowledge Ball owns Economy + Memory + Knowledge; NewHumans owns Identity + Goals + Lifecycle + Relationships.
- [x] **Referenced:** NewHumans may keep stable KB references and non-authoritative read projections only.
- [x] **Forbidden:** NewHumans may not maintain a second independently writable Economy/Memory/Knowledge authority.
- [x] NewHumans account balance is defined as a display/reference of the Knowledge Ball authoritative balance.
- [x] standalone and embedded Knowledge Ball identity semantics do not create duplicate NewHumans identities.
- [x] runtime/checkpoint state is distinguished from long-term Memory authority.
- [x] V3, module docs, current sequencing and existing Economy ADR conflicts are explicitly resolved.
- [x] ADR-001 protocol-versioning requirements remain intact.
- [x] current executable M05 migration debt is acknowledged; NH-002 does not falsely claim code migration is complete.
- [x] NH-002 changes no Knowledge Ball internals, runtime files, migrations, schemas or tests.

## 10. Consequences

- NewHumans must build an adapter/boundary around Knowledge Ball instead of rebuilding Economy/Memory/Knowledge core logic.
- M02 autonomous runtime treats Knowledge Ball as an external authoritative dependency while retaining its own lifecycle/goal authority.
- current local Economy code requires a separate versioned cutover task.
- future products may integrate the same Knowledge Ball authority without cloning its internal model.
- any future NewHumans task proposing a new writable Economy/Memory/Knowledge store conflicts with this ADR unless a later explicit ADR supersedes it.

## 11. Non-goals

NH-002 does not:

- modify Knowledge Ball code or schema;
- build the Knowledge Ball API/SDK/adapter;
- migrate or delete current M05 tables/services;
- change runtime/server/scheduler/policy/control behavior;
- change identity, goal, lifecycle or relationship schemas;
- perform data migration;
- change Energy numeric rules, daily-fee rules, knowledge review rules or memory content rules;
- enable autonomous cognition while the authoritative Knowledge Ball integration is unavailable.
