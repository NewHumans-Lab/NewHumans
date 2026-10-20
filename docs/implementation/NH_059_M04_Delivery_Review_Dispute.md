# NH-059 — Contract delivery, review, rework, and dispute opening

Status: implementation candidate; no public HTTP routes are added in this task.

## Implemented domain operations

- submitDelivery: only the contractor may submit against the current ACTIVE contract version. Idempotency keys are bound to the same actor, version, and artifact reference; same-key replay returns the original delivery even after the contract changes state.
- reviewDelivery: only the employer may accept or request rework for a SUBMITTED delivery. Acceptance stores the review evidence and leaves the contract SUBMITTED for the settlement Saga. Rework records the rejection, returns the contract to ACTIVE, and respects the version's rework_limit.
- raiseContractDispute: either contract party may open a dispute for the current version; it records reason/evidence and transitions the contract to DISPUTED. A referenced delivery is marked DISPUTED.

## Safety boundaries

- No operation here creates a Saga/Outbox command or moves funds.
- A contract cannot be marked SETTLED by delivery review.
- Dispute resolution is deliberately not implemented in this task: it requires a trusted reviewer/arbitrator authorization source. A client-supplied reviewer ID is not authority.
- Milestone-specific submission is fail-closed with MILESTONE_WORKFLOW_NOT_SUPPORTED until milestone completion semantics are implemented, rather than silently treating one milestone as whole-contract completion.
- No Knowledge Ball repository, ledger, or internal identity implementation is modified.

## Regression coverage

Integration tests cover same-key delivery replay after state transition, payload conflict rejection, employer-only review, accepted delivery without financial side effects, rework limit enforcement, and version-bound dispute opening.

## Next dependencies

- NH-060: trusted M01 identity binding and reviewer authorization contract.
- NH-061: authoritative Knowledge Ball escrow balance/receipt and settlement allocation invariant.
- NH-062: HTTP routes only after trusted command context and service contracts are in place.
- NH-063: milestone and full lifecycle recovery tests.
