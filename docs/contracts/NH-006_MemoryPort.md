# NH-006 — MemoryPort contract

Status: **authoritative NewHumans boundary contract**  
Scope: NewHumans ↔ Knowledge Ball durable-memory operations only. Knowledge Ball internals are out of scope.

## 1. Authority and ownership

NH-002 establishes the governing rule: **Knowledge Ball is the only writable authority for durable Memory**. `MemoryPort` is the NewHumans business-operation boundary for that authority.

NewHumans MUST NOT add a second durable memory database, Personal Overlay authority, writable memory mirror, model-vendor long-term store, per-model memory silo, per-thread long-term store, or an offline/fallback authority that later synchronizes into Knowledge Ball.

M02 working memory, runtime checkpoints, execution caches and logs may exist for bounded runtime continuity, but they are not durable personal memory and cannot become an alternate recall/write authority.

Model/provider/thread/device/worker changes do not create a new durable memory subject. They may appear only as provenance or runtime metadata.

NH-006 does not modify Knowledge Ball internals and does not create any NewHumans memory table or migration.

## 2. Trusted subject binding

The client payload does not choose its durable `subject_id`. NewHumans derives it from trusted M01 identity/binding state before MemoryPort dispatch.

Bindings carry `world_id`, `actor_entity_id`, actor type, binding mode and `binding_authority = M01`.

Two modes are defined:

- `SELF`: Human → that Human Entity ID; independent Agent → that Agent Entity ID.
- `HPA`: normal Human Proxy Agent → its bound Human Entity ID.

Therefore a Human and their normal HPA use the **same Human `memory_subject_id`**. The HPA still remains the executor: `actor_entity_id` and `provenance.executor_entity_id` identify the HPA. This prevents proxy work from being rewritten as proof that the Human personally read, observed, experienced or accepted something.

If M01 later establishes an Agent as an independent subject, M01 supplies a `SELF` binding for that Agent. MemoryPort does not infer awakening, ownership or identity changes.

All read/write operations fail closed when the requested `subject_id` differs from the M01-derived subject. Generic Agent delegation is not permission to write another subject's durable memory.

## 3. Business operations

### 3.1 `recall`

Read-only retrieval of Knowledge Ball memory relevant to a current problem, goal or query.

Required fields:

- `schema_version = nh.v3.0`
- `port = MemoryPort`
- `authority = KNOWLEDGE_BALL`
- trusted `world_id`
- `operation = recall`
- trusted `subject_id`
- trusted `actor_entity_id`
- `subject_binding = SELF | HPA`
- non-empty `query`

Optional: `time_range`, `limit`, opaque `cursor`.

Recall results are Knowledge Ball results. NewHumans must not splice model-local memory into the result as an equal durable authority.

### 3.2 `append_experience`

Append a durable subject-linked experience/source reference to Knowledge Ball.

Additional required fields:

- stable `idempotency_key`
- `occurred_at`
- non-empty `experience`
- `provenance`

For HPA execution, `subject_id` remains the Human while the executor fields remain the HPA. Knowledge Ball owns the mapping from this request into its Source/Event, Personal Overlay, graph objects and memory history; NewHumans does not reproduce that storage model.

### 3.3 `update_relation`

Request a Knowledge Ball-owned **memory-domain relation** mutation for the bound subject.

Additional required fields:

- stable `idempotency_key`
- non-empty `relation`
- `provenance`
- optional `expected_version`

This operation does **not** write NewHumans authoritative social/organization/contract relationships. NH-002 keeps those Relationships in NewHumans. `update_relation` here only addresses a relation whose business authority belongs to Knowledge Ball Memory; an adapter must reject/reroute any relationship type owned by NewHumans.

`expected_version` is an optimistic-concurrency input; provider-side stale writes use the canonical KB error model.

### 3.4 `history`

Read durable subject memory history from Knowledge Ball, optionally filtered by `from`, `to`, `kind`, `limit` and opaque `cursor`.

This is provider history, not reconstructed model chat history or runtime logs.

## 4. Cursor contract

A MemoryPort cursor is an opaque Knowledge Ball continuation token.

- NewHumans may persist/pass it only for continuation.
- NewHumans must not decode, synthesize, increment or reinterpret it.
- Knowledge Ball may bind it to subject, world, operation, query/filter and provider snapshot.
- Cross-subject or incompatible-filter reuse must fail closed rather than expose records.
- A cursor is not a durable record/source/history ID.

## 5. Source provenance

Every durable write requires provenance containing at least:

- `source_id`
- `source_kind`
- `source_authority`
- `recorded_at`
- `executor_entity_id`

Optional references include `world_event_id`, `upstream_source_id` and `content_digest`.

On the NewHumans call path, `provenance.executor_entity_id` must equal the trusted `actor_entity_id`. For an HPA, this deliberately differs from the Human `subject_id`.

Where an authoritative M01 event/source exists, world-mode writes should reference it. Model output may be represented as a derived source with provenance, but model identity never becomes the durable memory authority or subject partition key.

## 6. Idempotency boundary with NH-009

NH-006 requires `append_experience` and `update_relation` requests to carry a stable `idempotency_key` and to be reproducible with the same MemoryPort business payload across a duplicate send.

The **canonical cross-product uniqueness scope, payload digest, retry budget, request/correlation IDs, conflict handling and `OUTCOME_UNKNOWN` reconciliation are owned by NH-009**, not redefined here. In particular, MemoryPort adapters must hand the stable business request to the NH-009 idempotency/retry layer rather than implementing a second dedupe algorithm.

MemoryPort conformance must prove that rebuilding the same logical write preserves the same `world_id`, `actor_entity_id`, `operation`, `idempotency_key`, subject and semantic payload so NH-009/Knowledge Ball can deduplicate it. End-to-end duplicate-write tests must prove no second durable memory item is created once the provider/idempotency layer is wired.

## 7. Readiness and canonical errors

NH-010 owns KB capability readiness. Before dispatch:

- `recall` / `history` require Memory read readiness;
- `append_experience` / `update_relation` require Memory write readiness.

NH-006 does not duplicate that readiness state machine.

Provider-facing failures reuse NH-008 canonical KB errors, including:

- `BINDING_MISSING` for absent required binding;
- `AUTH_FAILED` for invalid/forged binding or subject-scope violation;
- `STALE_VERSION` for obsolete provider versions;
- `OUTCOME_UNKNOWN` where a write may have committed and reconciliation is required.

`INVALID_MEMORY_AUTHORITY` and `MODEL_SCOPED_LONG_TERM_MEMORY_FORBIDDEN` are local NewHumans integration/configuration guards, not a second Knowledge Ball transport-error taxonomy.

## 8. Machine contract

- `src/ports/memory-port.js` contains state-free request builders and boundary guards only.
- `schemas/memory-port.schema.json` defines requests/results for the four MemoryPort operations.
- Neither file persists memory or implements a Knowledge Ball fallback.
- Knowledge Ball response payload internals remain provider-owned; the boundary fixes authority, identity scope, cursor handling and provenance fields without cloning its graph schema into NewHumans.

## 9. Acceptance invariants

NH-006 is accepted only when all remain true:

1. Knowledge Ball is the sole durable Memory authority.
2. No model-specific/thread-specific durable memory store exists.
3. Human and normal HPA resolve to the same Human memory subject.
4. HPA executor provenance is preserved separately from the Human subject.
5. Independent Agents cannot read or write another subject through MemoryPort.
6. Durable writes require source provenance.
7. Durable write requests carry a stable idempotency key and remain compatible with NH-009 duplicate suppression.
8. Cursors remain opaque and subject-scoped.
9. `update_relation` cannot become a backdoor for NewHumans-owned Relationships.
10. No NewHumans memory table, migration, fallback authority or Knowledge Ball internal implementation is introduced.

## 10. Required test matrix

| Case | Expected result |
| --- | --- |
| Human SELF + own subject | allowed |
| HPA + bound Human subject | allowed; subject = Human |
| Human vs HPA binding | same `memory_subject_id` |
| independent Agent + another subject | `AUTH_FAILED` |
| recall/history + another subject | `AUTH_FAILED` |
| HPA durable write | Human subject + HPA executor provenance |
| forged provenance executor | `AUTH_FAILED` |
| duplicate logical write construction | byte-equivalent business request with same stable idempotency key/scope inputs |
| opaque cursor round trip | token unchanged; same bound subject |
| authority != Knowledge Ball | rejected locally |
| model-scoped durable memory enabled | rejected locally |

Provider integration acceptance later extends the duplicate-write case through NH-009/Knowledge Ball and must observe one authoritative durable memory mutation only.

## 11. PERFECT_REPLACEMENT audit

`Replacement-Audit: NOT_APPLICABLE`

NH-006 adds a boundary contract where no current NewHumans MemoryPort executable path exists. It does not replace Knowledge Ball internals, runtime hot files, current M02 control logic, or the still-existing legacy migration debt identified by NH-002.
