# NH-007 KnowledgePort Contract

Status: implementation contract  
Contract version: `nh.knowledge-port.v1`  
Owner direction date: 2026-10-01

## 1. Boundary

Knowledge Ball remains an independent product and the authoritative owner of its knowledge graph, knowledge IDs, sources, evidence, challenges, Personal Overlay, beliefs and judgments. NewHumans integrates it through this port.

NewHumans MUST NOT:

- copy the Knowledge Graph into a second authoritative local graph;
- allocate replacement IDs for Knowledge Ball objects;
- reinterpret a provider read failure as an empty successful query;
- maintain a second mutable current belief/judgment state outside Knowledge Ball;
- resolve one subject's Personal Overlay by mutating another subject's state;
- bypass Knowledge Ball idempotency/version checks for writes.

NewHumans MAY cache read projections for performance, provided the cache is explicitly non-authoritative, keyed by external reference, invalidatable, and never accepted as a write source of truth.

This contract refines the existing `kb.*` integration surface. It does not replace the M03 cognitive/domain model and does not implement a local Knowledge Ball.

## 2. External stable references

Every Knowledge Ball object crossing the boundary uses an opaque external reference:

```json
{
  "provider": "knowledge-ball",
  "namespace": "public",
  "kind": "CLAIM",
  "id": "claim-3f4f...",
  "revision": 7
}
```

Required fields:

| Field | Meaning |
| --- | --- |
| `provider` | External provider identity. NewHumans does not invent it. |
| `namespace` | Provider namespace/world/domain scope. |
| `kind` | External object type. |
| `id` | Opaque stable external ID. Must be a non-empty string. |
| `revision` | Optional provider revision/version. It does not change the stable object identity. |

Supported boundary kinds are `NODE`, `CLAIM`, `REFERENCE`, `SOURCE`, `ASSERTION`, `EVIDENCE`, `CHALLENGE`, `BELIEF`, `JOB`, and `CORRECTION`.

The stable identity key is `(provider, namespace, kind, id)`. NewHumans must not treat display names, graph coordinates, labels, local SQL row numbers, URLs, or array positions as knowledge identity.

## 3. Port operations

`src/ports/knowledge_port.js` exposes a validated facade over an external provider. The provider owns persistence and domain behavior.

| KnowledgePort method | Existing semantic surface | Purpose |
| --- | --- | --- |
| `query` | `kb.query` | Query knowledge and receive external refs plus read projections. |
| `readNode` | `kb.get_claim` / provider node read | Read one external node/claim/assertion/reference. |
| `resolveReference` | `kb.resolve_reference` | Resolve legacy/alias/reference IDs to a canonical external ref or tombstone status. |
| `submitEvidence` | `kb.submit_evidence` | Attach supporting/refuting/context evidence to an external target. |
| `createChallenge` | `kb.challenge` | Create a challenge against an external target. |
| `readPersonalOverlay` | `kb.get_personal_overlay` | Read the sparse personal state for exactly one subject. |
| `declareBelief` | `kb.declare_belief` | Record a belief declaration/history event; current state is returned as `judgment`. |
| `resolvePersonalChallenge` | `kb.resolve_personal_challenge` | Resolve one subject's challenge review with version/evidence binding. |

The JavaScript method names are transport-neutral adapter names. A concrete Knowledge Ball adapter may call HTTP, RPC, SDK, or an embedded provider, but the semantics above must remain one-to-one.

Adjacent contract ownership is intentionally not duplicated here:

- NH-008 owns canonical Knowledge Ball provider error classification and retry/reconciliation disposition; KnowledgePort consumes that model.
- NH-009 owns cross-product idempotency scope, payload digests, retry budgets, and `OUTCOME_UNKNOWN` replay/reconciliation policy; KnowledgePort only requires the operation-level idempotency key and preserves provider duplicate semantics.
- NH-010 owns Knowledge Ball capability readiness and read/write gating; callers/adapters must compose that guard around KnowledgePort dispatch rather than introducing readiness state inside this port.

## 4. Query and node read

A query requires at least one of `text`, structured `filters`, or external `refs`. A successful result contains `items`, each carrying an external `ref`. Optional display/projection data is read-only.

A node read accepts an external `ref` and returns the same externally rooted object identity. Evidence and challenges are returned as external refs.

Failure rules are strict:

- provider `UNAVAILABLE` remains an explicit retryable failure;
- provider `TIMEOUT` remains an explicit retryable failure;
- unknown provider/network failures normalize to NH-008 `UNAVAILABLE`;
- legacy provider codes such as `DEPENDENCY_UNAVAILABLE` are compatibility inputs only and normalize to NH-008 codes;
- NewHumans must not convert a failed read into `{items: []}` or a fabricated node.

An empty successful query means the provider successfully searched the requested coverage and found no matching results. It is semantically different from provider failure.

## 5. Evidence writes and duplicate writes

`submitEvidence` requires:

- `target_ref` as an external knowledge target;
- `source_ref` as an external source/reference;
- `stance = SUPPORTS | REFUTES | CONTEXT`;
- `idempotency_key`;
- optional `expected_version`.

The provider remains responsible for source-root deduplication and independence semantics.

Idempotency contract:

1. same operation scope + same `idempotency_key` + same semantic payload returns the original result/ref;
2. it does not create a second evidence object or repeat side effects;
3. same idempotency key with a different semantic payload returns canonical NH-008 `CONFLICT`;
4. missing idempotency key is rejected before provider dispatch.

NewHumans must preserve the external `evidence_ref` returned by Knowledge Ball instead of minting a local evidence ID.

## 6. Challenges

`createChallenge` requires:

- external `target_ref`;
- zero or more external `evidence_refs`;
- explicit `objection_type`;
- explicit `requested_outcome`;
- `idempotency_key`;
- optional `expected_version`.

The result returns an external `challenge_ref` and provider status.

A public challenge and a subject's personal challenge review are different objects/semantics. Creating or resolving one personal review must not silently close the public challenge or another subject's pending review.

## 7. Personal Overlay

`readPersonalOverlay` is always scoped by `subject_id`. The provider response must echo the same subject.

Each item contains an external `node_ref` and the personal projection. Required current fields are:

- `judgment = UNASSESSED | ACCEPTED | CONFIRMED_WRONG`;
- `pending_challenge_count >= 0`.

Optional fields may include `seen`, `remembers`, `created_by_self`, `correction_refs`, and `state_version`.

Isolation invariant:

`(subject_id, external node ref)` is the personal-state boundary. A write for subject A may change A's Personal Overlay and history only. It must not mutate subject B's judgment, memory, pending challenge count, corrections, or history.

## 8. Belief and judgment

Belief history and current personal judgment are deliberately not two independent writable authorities.

`declareBelief` records a declaration/history action. It requires subject, external target, `position = ACCEPT | RETRACT`, idempotency, and optional version/confirmation data. The result returns an external `belief_ref` plus the provider's resulting current `judgment`.

The current personal state is the Knowledge Ball Personal Overlay `judgment`. NewHumans must not persist a separate mutable `accepted` boolean. Any convenience `accepted` view must be derived from `judgment == ACCEPTED`.

For Human-backed final decisions, a concrete adapter must additionally enforce the current identity/confirmation rules. The generic port only transports `confirmation_ref`; it does not manufacture or validate owner confirmation itself.

## 9. Resolving a personal challenge

`resolvePersonalChallenge` requires:

- external `challenge_ref`;
- `subject_id`;
- `decision = UPHOLD | ACCEPT_CORRECTION`;
- `evidence_version`;
- `idempotency_key`;
- optional `expected_version` and `confirmation_ref`;
- for `ACCEPT_CORRECTION`, an external `correction_ref`.

The result returns the same subject, challenge ref, current judgment, and `remaining_pending` count. Resolving one challenge does not imply that all pending challenges are resolved.

## 10. Error contract

NH-007 does not define a second provider error taxonomy. Provider failures use the merged NH-008 authority in `src/shared/kb_errors.js`:

- `UNAVAILABLE`
- `TIMEOUT`
- `AUTH_FAILED`
- `BINDING_MISSING`
- `STALE_VERSION`
- `INSUFFICIENT_ENERGY`
- `CONFLICT`
- `OUTCOME_UNKNOWN`

Retryability and reconciliation behavior come from that shared model. In particular, `OUTCOME_UNKNOWN` requires reconciliation and must not be treated as a retryable timeout.

The port may accept old provider spellings only as compatibility input: `DEPENDENCY_UNAVAILABLE`/`KNOWLEDGE_UNAVAILABLE` map to `UNAVAILABLE`, `UNAUTHENTICATED`/`FORBIDDEN` map to `AUTH_FAILED`, and `IDEMPOTENCY_CONFLICT` maps to `CONFLICT`. The original provider code is retained in error details for diagnostics. Unknown provider errors normalize to `UNAVAILABLE`.

Invalid port DTOs are not Knowledge Ball provider failures; they raise `INVALID_KNOWLEDGE_PORT_CONTRACT` before dispatch.

## 11. Required contract tests

NH-007 acceptance requires the following tests and equivalent future adapter tests:

1. **Query failure** — an unavailable provider fails explicitly; it is not returned as an empty successful query.
2. **Read failure** — a provider timeout/unavailable read remains an explicit failure; no placeholder node is fabricated.
3. **Write duplicate** — retrying the same evidence write with the same idempotency key returns the same external ref and creates one provider write only.
4. **Idempotency conflict** — same key with a changed semantic payload returns NH-008 `CONFLICT`.
5. **Challenge** — challenge creation returns an external challenge ref and creates personal pending work without redefining public truth.
6. **Personal state isolation** — resolving subject A's challenge changes A only; subject B remains unchanged and pending.
7. **Belief/judgment authority** — a belief declaration returns provider judgment, and the Personal Overlay remains the single current state authority.
8. **External ID enforcement** — local numeric IDs or refs without provider/namespace are rejected.

The repository unit fixture used by NH-007 is test-only. It is not a production fallback provider and must never be wired into runtime behavior.

## 12. Acceptance

NH-007 passes only when:

- NewHumans contains no copied Knowledge Graph or local knowledge truth store;
- all knowledge-facing IDs crossing the port are opaque external stable refs;
- provider read failures remain explicit;
- writes require idempotency and preserve provider IDs;
- challenge semantics and personal-state isolation are covered by tests;
- belief history does not become a second current judgment authority;
- no PR #17 runtime hotspot file is changed.
