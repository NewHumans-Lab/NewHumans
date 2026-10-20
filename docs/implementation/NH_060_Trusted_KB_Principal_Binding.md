# NH-060 — Trusted Knowledge Ball principal binding

Status: implementation candidate; no production KB identity adapter or HTTP enrollment route is claimed.

## Design alignment

NH-002 assigns NewHumans/M01 ownership of Entity identity and requires an explicit, auditable, versioned binding to a standalone Knowledge Ball account. The KB principal remains an opaque reference; NewHumans does not create or modify KB identity, wallet, memory, knowledge, or ledger records.

## Implemented

- Migration 0529 adds core.entity_provider_bindings with immutable verification evidence, binding versions, ACTIVE/REVOKED states, world-scoped Entity references, one active binding per Entity, and one active Entity per canonical KB principal.
- Binding creation requires an injected trusted identityPort.verifyBindingProof adapter. The persisted principal_ref is taken only from that adapter's verified result; client-supplied principal_ref is rejected.
- External verification is performed outside a PostgreSQL transaction. The service rechecks M01-side authorization and uniqueness inside a second local transaction before writing.
- Self-binding is permitted for an active Entity. Binding another Entity requires an active capability grant from that target Entity containing identity.bind_knowledge_ball.
- Creation and revocation append core life events and outbox entries. Revocation is terminal for a binding record; a replacement creates a higher version.
- resolveKnowledgeBallPrincipal returns only an active binding for an active Entity and fails closed if none exists.

## Security and operational limits

- The actual Knowledge Ball identity verification adapter is not implemented or live-verified. Without an injected trusted provider, binding creation returns KB_IDENTITY_PROVIDER_UNAVAILABLE.
- The HTTP server's current header-derived actor context is still a development adapter, not production authentication. This service is not wired to a public route.
- Revocation prevents future NewHumans resolution; in-flight financial Sagas must still reconcile using their already-persisted operation identity and result evidence.
- Never fall back to display name, email, model behavior, or client-supplied principal_ref.
- No Knowledge Ball repository or internals are changed.

## Required next steps

- Implement/verify the real KB identity adapter and signed/challenge-based proof semantics.
- Use resolveKnowledgeBallPrincipal in activation/settlement orchestration rather than accepting principal_ref from public payloads.
- Add trusted reviewer/arbitrator authorization before dispute resolution.
- Keep financial endpoints disabled until principal binding and authoritative escrow-balance verification both pass.
