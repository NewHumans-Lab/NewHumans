# ADR-022 — Knowledge Ball is the sole Economy, Memory, and Knowledge authority

Status: **Accepted**  
Task: **NH-002**  
Decision date: **2026-10-01**  
Scope: architecture and data-authority boundary only  
Migration state: **BOUNDARY_ACCEPTED / EXECUTABLE_REPLACEMENT_PENDING**

## 1. Context

NewHumans V3 was written before the final decision to keep Knowledge Ball as an independent product that can also be embedded into NewHumans. V3 therefore split authority across an internal M03 Knowledge Ball and an internal M05 Economy, while M02 documentation also described NewHumans as retaining long-term memory and Personal Overlay state.

The current owner decision is different and takes precedence for this boundary:

- the existing Knowledge Ball remains an independent product;
- Knowledge Ball is the single writable authority for **Economy + Memory + Knowledge**;
- NewHumans must not create or retain a second independently writable authority for those domains;
- NewHumans remains authoritative for **Identity + Goals + Lifecycle + Relationships**;
- NewHumans may display, reference, index, cache, or project Knowledge Ball data only when that copy cannot become a competing source of truth;
- this task does not modify Knowledge Ball internals and does not migrate runtime/economy code.

This ADR resolves the ownership decision only. It does not claim that the current repository has already completed the executable migration. Existing NewHumans M05 write paths are therefore legacy implementation pending replacement, not the target architecture.

## 2. Decision

### 2.1 Authoritative ownership

| Domain | Writable authority | NewHumans role | Knowledge Ball role |
| --- | --- | --- | --- |
| Identity | NewHumans / M01 | Own Entity identity, authentication binding, delegation, HPA binding, identity status and authorization roots | Reference NewHumans Entity/subject identity in embedded mode; never mint a competing NewHumans identity |
| Goals | NewHumans / M02 | Own current goal state, dependencies, versions and goal lifecycle | Store/query knowledge or history references to goals; no authoritative goal mutation |
| Lifecycle | NewHumans / M02 | Own REGISTERED/ACTIVE/DORMANT/TERMINATED and runtime eligibility state | Read lifecycle facts when needed for memory/economy/knowledge policy; no authoritative lifecycle mutation |
| Relationships | NewHumans / M04, with M01/M02 for relationship types produced by identity/birth/governance workflows | Own social, organizational, contractual and generated relationship state according to the relevant NewHumans domain | Store/query references, evidence, interpretations and historical projections; no authoritative relationship mutation |
| Economy | **Knowledge Ball** | Consume Economy API/SDK results; display balances; request authorized economic operations; keep non-authoritative request/result references only | Own Energy wallet/balance, available balance, journals/postings, reservations, escrow, settlement, mint/burn/retirement, activity fees and other authoritative economic state |
| Memory | **Knowledge Ball** | Request retrieval and submit authorized memory events/references; use returned context; never maintain a second writable long-term memory store | Own long-term personal memory, Personal Overlay/personal state, memory references, recall/index state and memory history |
| Knowledge | **Knowledge Ball** | Submit/query through the Knowledge Ball contract and render results | Own public knowledge graph, canonical nodes/claims, evidence, sources, disputes/challenges, review state and knowledge history |

The ownership rule is semantic, not deployment-specific. Knowledge Ball may run in the same PostgreSQL cluster, another service, a standalone deployment, an SDK/embedded mode, or a future implementation. Physical co-location never grants NewHumans a second writable authority.

### 2.2 Identity unification across standalone and embedded Knowledge Ball

Knowledge Ball may support its own authentication adapter when used standalone. That standalone account/subject identifier is not a second NewHumans Entity identity.

When Knowledge Ball is embedded in NewHumans:

1. `entity_id` / the approved NewHumans subject reference comes from NewHumans M01.
2. Knowledge Ball binds its Economy, Memory and Knowledge subject state to that external identity reference.
3. Knowledge Ball does not independently decide that two NewHumans Entities are the same person, split one Entity into two identities, or reassign an Entity ID.
4. Model replacement, worker replacement, device changes and multiple chat threads do not create new Economy/Memory identities for the same NewHumans Entity.
5. Any standalone-to-NewHumans account linking requires an explicit mapping/linking workflow with audit evidence; matching names, emails, model behavior or content similarity is insufficient.

Thus identity stays unique in NewHumans while Economy/Memory/Knowledge stay unique in Knowledge Ball.

## 3. Allowed reference model

NewHumans is allowed to hold references or derived read models from Knowledge Ball only when all of the following are true:

- the record contains the Knowledge Ball authority identifier and, where applicable, version/cursor/event reference;
- the record is explicitly non-authoritative or mechanically reconstructable from Knowledge Ball;
- it cannot accept independent business writes that change Economy, Memory or Knowledge truth;
- stale data is detectable and critical writes revalidate against Knowledge Ball rather than trusting the projection;
- deleting/rebuilding the projection cannot alter the authoritative Knowledge Ball state;
- retry/replay cannot create an independent NewHumans journal, memory history or knowledge decision.

Examples of allowed NewHumans data:

- `kb_wallet_ref`, displayed balance snapshots and last-seen economy cursor;
- `kb_memory_ref`, context retrieval references and checkpoint references;
- `kb_claim_ref`, `kb_source_ref`, challenge/reference IDs and read-model search indexes;
- request IDs, idempotency keys, operation status and signed/verified Knowledge Ball result receipts needed to coordinate a NewHumans workflow.

These references are not permission to duplicate the underlying writable domain state.

## 4. Forbidden second-authority patterns

NewHumans must not introduce, preserve as a target architecture, or later revive any of the following:

1. a local writable Energy wallet or balance that can diverge from Knowledge Ball;
2. a local authoritative journal/posting/reservation/escrow/settlement path parallel to Knowledge Ball Economy;
3. a local long-term memory table, Personal Overlay, belief/memory state, recall authority or model-specific memory silo that can be independently changed;
4. a second writable public knowledge graph, canonical claim store, evidence verdict, challenge state or review state;
5. bidirectional synchronization where both NewHumans and Knowledge Ball can accept authoritative writes for the same Economy/Memory/Knowledge fact;
6. last-write-wins reconciliation between two writable authorities;
7. an adapter cache whose local mutation can later be uploaded as authoritative state without the Knowledge Ball write contract;
8. treating an M01 event log, M02 checkpoint, M04 message/relationship record, M06 usage receipt or M07 UI state as an alternative Economy/Memory/Knowledge authority;
9. using a temporary substitute memory/economy/knowledge implementation to bypass an unavailable Knowledge Ball dependency in production;
10. calling an old NewHumans M05/M03 path authoritative merely because it still exists during migration.

A compatibility layer is allowed only when it has one authoritative write destination: Knowledge Ball. A temporary read bridge must have an explicit removal condition and must not accept independent authoritative writes.

## 5. NewHumans-owned domains remain authoritative

This ADR does **not** move the following into Knowledge Ball:

- M01 Entity identity, authentication, HPA binding, delegation, authorization roots, world rules and action authority;
- M02 lifecycle, runtime leases/checkpoints, current goals and goal dependencies, model route/runtime state and scheduling;
- M04 social/organizational/contractual relationship state and other relationship records assigned to NewHumans by current domain rules;
- M06 provider/model/tool execution authority and usage measurement;
- M07 presentation state.

Knowledge Ball may preserve references, evidence, interpretations and history about those facts. Those records never gain authority to mutate the underlying NewHumans domain.

A knowledge statement such as “Entity A is ACTIVE”, “A has goal G”, or “A is a member of organization O” is a reference/claim about an authoritative NewHumans fact. Accepting, disputing or indexing that statement in Knowledge Ball does not directly change the NewHumans lifecycle, goal or relationship record.

## 6. Cross-domain operation rule

A workflow that touches both sides must preserve one authority per fact.

Examples:

- **Activation:** NewHumans M02 owns the lifecycle transition; it asks Knowledge Ball Economy for the authoritative fee/balance operation and uses the returned result as an input to the M02 transition. NewHumans does not post a second local fee journal.
- **Model execution:** M06 owns measured provider/tool usage; Knowledge Ball Economy owns the resulting Energy charge. A usage receipt is evidence/input, not the wallet.
- **Contract settlement:** M04 owns contract state and relationship consequences; Knowledge Ball Economy owns escrow and settlement money state. Each side stores the other's stable reference needed for atomic/saga coordination.
- **Autonomous turn:** M02 owns turn/lifecycle/goal state; Knowledge Ball Memory/Knowledge supplies context and receives authorized memory/knowledge submissions; M02 checkpoint references KB objects instead of duplicating their writable content.
- **Identity-linked memory:** M01 owns the subject identity; Knowledge Ball owns the subject's memory. A subject mapping cannot be rewritten by a memory operation.

Until a concrete cross-system transaction protocol is implemented, code must fail closed rather than create a second local authority to simulate success.

## 7. Conflict audit against V3 and current repository decisions

The following older statements are superseded only to the extent listed here. Unrelated invariants remain in force.

| Existing source | Existing meaning | ADR-022 resolution |
| --- | --- | --- |
| `docs/NewHumans_System_Spec_V3.md` §2 module table | M03 owns knowledge/memory; M05 owns Energy/economy | **Superseded ownership split.** Knowledge Ball owns Economy + Memory + Knowledge. NewHumans keeps Identity + Goals + Lifecycle + Relationships. |
| `docs/modules/03_Knowledge_Ball.md` §1.2 | real balance is outside Knowledge Ball | **Superseded.** Authoritative Energy/economy state is now part of Knowledge Ball. Identity, permissions, contracts, relationships, lifecycle and goals remain external NewHumans facts. |
| `docs/modules/03_Knowledge_Ball.md` §2 | world mode gets budget from M05 | **Superseded.** Embedded KB Economy is the budget authority; NewHumans calls it through the integration contract. |
| `docs/modules/05_Energy_and_Resources.md` | M05 is authoritative for wallets, journals, reservations, escrow, fees, issuance and settlement | **Superseded as target ownership.** Those accounting semantics may be reused, but the writable authority must live in/be provided by Knowledge Ball. Existing NewHumans M05 executable paths are migration debt, not a second target authority. |
| `docs/modules/02_Agent_Life_Runtime.md` §2.1 | NewHumans stores long-term memory and Personal Overlay alongside goals/relationships | **Partially superseded.** Goals/lifecycle remain NewHumans-owned; long-term memory and Personal Overlay move to Knowledge Ball authority. |
| `docs/modules/02_Agent_Life_Runtime.md` §1 and §6 | M02 references M03 for memory/knowledge and M05 for budget | **Interface updated conceptually.** Both dependencies resolve to the authoritative Knowledge Ball provider, while M02 ownership itself is unchanged. |
| `docs/modules/04_Social_Collaboration.md` | M04 owns relationships; M05 owns money | **Partially retained.** Relationship ownership stays in NewHumans/M04; money dependency changes to Knowledge Ball Economy. |
| `docs/modules/01_World_Core.md` | M01 owns identity, M05 owns balance | **Partially retained.** Identity ownership stays in M01; balance/economic checks must come from Knowledge Ball Economy after integration. |
| `docs/CURRENT_DEVELOPMENT_SEQUENCE.md` | final Knowledge Ball path is undecided; V3 ownership remains unchanged | **Owner decision resolved.** Reuse/integrate Knowledge Ball as the authority is now decided. The sequencing rule against fake/temporary M03 remains valid until integration is implemented. |
| `DECISIONS.md` ADR-003/004/009 | microE, balanced journals and append-only economic evidence | **Semantic invariants retained** unless a later explicit decision changes them; they no longer imply NewHumans owns the ledger. |
| `DECISIONS.md` ADR-006 | local `economy.activity_subjects` accounting fact and M02 separation | **Implementation-specific local economy reference becomes migration debt.** M02 separation remains valid. |
| `DECISIONS.md` ADR-013 | “M05 remains the only authority” for money | **Superseded.** Knowledge Ball Economy is the only money authority. The rule that M06 does not own money remains valid. |
| `DECISIONS.md` ADR-015/016/018/021 | execution eligibility, usage settlement, quote-backed execution and immutable billing evidence depend on M05 | **Economic semantics retained, authority endpoint changes.** Future integration must source those decisions/operations from Knowledge Ball Economy rather than a second NewHumans ledger. |

### Conflict-audit result

- **Identity:** no conflict after retaining M01 authority.
- **Goals/lifecycle:** no conflict after retaining M02 authority.
- **Relationships:** no conflict after retaining NewHumans relationship authority.
- **Memory/Personal Overlay:** old NewHumans/M02 ownership wording is superseded.
- **Knowledge:** existing Knowledge Ball ownership is retained and strengthened as the sole writable authority.
- **Economy/Energy:** old M05 ownership is superseded; current executable M05 is explicitly pending replacement.
- **Development sequencing:** fake/substitute KB paths remain forbidden; only the prior “undecided provider/ownership” statement is superseded.

There is therefore one target semantic owner for every affected domain. The repository is not yet claimed to have one final executable path for Economy because migration is intentionally outside NH-002.

## 8. Migration constraints for later tasks

Later implementation work must obey all of the following:

1. integrate through a versioned Knowledge Ball Economy/Memory/Knowledge contract;
2. do not modify Knowledge Ball internals merely to preserve NewHumans' former M05/M03 layout;
3. inventory every NewHumans writable M05 and long-term-memory path before enabling the KB write path;
4. define source-of-truth cutover and data migration explicitly; never run both authorities writable for the same world/subject during normal operation;
5. migrate references and idempotency evidence without duplicating monetary effects or memory/knowledge submissions;
6. update tests so they prove NewHumans cannot write authoritative Economy/Memory/Knowledge state locally;
7. keep current P3 fail-closed behavior where Knowledge Ball context/economy integration is unavailable rather than introducing a temporary substitute;
8. retire or permanently disable superseded local authority paths before declaring executable replacement complete.

## 9. Consequences

Positive consequences:

- Knowledge Ball remains usable standalone and embedded without forking its core Economy/Memory/Knowledge truth.
- NewHumans can evolve runtime/social/identity features without duplicating cognition or ledger state.
- model switching does not fragment memory or wallet identity.
- account balance shown in NewHumans can be the Knowledge Ball balance rather than a synchronized copy with independent write semantics.
- future products can integrate the same Knowledge Ball authority through adapters instead of cloning its data model.

Costs and constraints:

- current NewHumans M05 implementation cannot remain the final writable economy authority;
- cross-system operations need explicit idempotency, versioning, failure and reconciliation contracts;
- NewHumans read projections must tolerate staleness and revalidate critical operations;
- migration must handle existing local economic records without double-spending, double-charging or silently discarding audit history.

## 10. Acceptance for NH-002

This ADR is accepted only if all checks below hold:

- [x] `Owned`: Knowledge Ball owns Economy + Memory + Knowledge; NewHumans owns Identity + Goals + Lifecycle + Relationships.
- [x] `Referenced`: both products may retain stable cross-domain references and non-authoritative read projections.
- [x] `Forbidden`: NewHumans may not maintain a second independently writable Economy/Memory/Knowledge authority.
- [x] standalone and embedded Knowledge Ball identity semantics are separated without creating duplicate NewHumans identities.
- [x] V3 M03/M05/M02/M04/M01 ownership conflicts are explicitly resolved.
- [x] current `DECISIONS.md` economic ADR conflicts are explicitly resolved without discarding unrelated accounting invariants.
- [x] current sequencing prohibition on fake/substitute Knowledge Ball paths remains intact.
- [x] existing executable M05 migration debt is acknowledged; NH-002 does not falsely claim code migration is complete.
- [x] NH-002 changes no Knowledge Ball internals, runtime files, migrations, schemas or tests.

## 11. Non-goals

NH-002 does not:

- implement or modify Knowledge Ball;
- build the Knowledge Ball SDK/API/adapter;
- move or delete current M05 tables/services;
- change runtime behavior;
- change identity, goal, lifecycle or relationship schemas;
- perform data migration;
- enable autonomous cognition while the authoritative Knowledge Ball integration is unavailable.

Those are separate implementation tasks gated by this boundary decision.