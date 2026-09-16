# P1.3 M06 design-conformance hardening

Status: **IMPLEMENTED; FINAL-HEAD VERIFICATION PENDING**.

This slice exists because implementation conformance to the V3 design is the primary acceptance gate. Automated tests are evidence for the reviewed design; they are not a substitute for checking that the code implements the intended semantics.

## Design review findings

The merged P1.2 minimum gateway passed its final PostgreSQL 16 CI, but a design-to-code review found several semantics that were represented in descriptors or documentation without being fully enforced at runtime.

| V3 requirement | P1.2 state | P1.3 implementation |
| --- | --- | --- |
| Descriptor maximum input/output must constrain execution | Output maximum enforced; `max_input_tokens` was stored but not enforced | A conservative OpenAI-compatible input-token upper bound is checked before execution is created; provider-reported input/output usage is also checked against declared/requested limits |
| Every new provider send/retry must recheck current qualification, date and budget | Initial preparation checked once | Every attempt atomically rechecks active actor, current UTC billing date, charged activity fee, positive available Energy, active descriptor/connector, and platform reservation before marking the attempt `DISPATCHED` |
| Yesterday's activity qualification cannot start a new request | Not rechecked at retry | A retry whose billing date is no longer the current UTC date is rejected with `STALE_ACTIVITY_TICKET` before a second network request |
| A subject with no positive available Energy cannot start new activity | Initial reservation ownership/size checked | Current authoritative `wallet_balances.available_micro_e` must remain positive at every dispatch |
| PRIMARY and AUXILIARY model calls must be distinguishable | Free-text `action_purpose` | Application validation, JSON Schema and database constraint allow only `PRIMARY_INFERENCE` or `AUXILIARY_INFERENCE` |
| Known provider usage remains billable even if the local result contract fails | HTTP failures with usage were settled; successful HTTP with malformed output became cost-unknown | Usage is parsed first. If usage is trustworthy but output is malformed or exceeds the requested limit, the execution is `FAILED` while the known usage receipt and exact M05 settlement are preserved |
| External network I/O must not hold database locks | Implemented in P1.2 | Preserved: qualification + DISPATCHED state is one short transaction; HTTP starts only after commit |
| Ambiguous provider outcome must not be blindly replayed | Implemented in P1.2 | Preserved: timeout/ambiguous post-dispatch failures remain `OUTCOME_UNKNOWN`, reservation retained for reconciliation |

## Conservative input bound

A generic OpenAI-compatible connector does not necessarily expose the provider model's tokenizer. P1.3 therefore does **not** pretend to know exact input tokens before calling the provider. It computes a conservative upper bound from the UTF-8 serialized message bytes plus framing allowance and compares that bound with `max_input_tokens`.

This can reject some requests that the provider tokenizer would have accepted. That is intentional for the generic adapter: under-enforcing the declared maximum is worse than conservative rejection. A future provider-specific/tokenizer-aware adapter may use a tighter verified estimator without changing the descriptor contract.

## Dispatch transaction boundary

For every attempt, including retries:

```text
BEGIN short transaction
  lock execution
  resolve current actor
  verify current UTC billing date
  verify activity fee still CHARGED
  verify current available Energy > 0
  verify descriptor ACTIVE + connector enabled
  verify platform reservation ACTIVE / payer / authorization
  insert attempt + provider-request record
  mark execution/action DISPATCHED
COMMIT

provider HTTP request
```

This satisfies both requirements that current qualification is authoritative at send time and that provider latency must not create long-running database transactions.

## Known usage versus unknown outcome

P1.3 distinguishes two materially different cases:

- **Known provider usage, unusable local output:** the provider response proves measured token usage. M05 settles that known usage and M06 records a receipt; the local execution is `FAILED` because the output contract is invalid.
- **Unknown provider execution/usage:** timeout, ambiguous network failure, or unusable response without trustworthy usage remains `OUTCOME_UNKNOWN`; the reservation is retained for reconciliation.

Known cost is not converted into unknown cost merely because the result payload is unusable.

## Deliberately still outside this slice

P1.3 does not claim completion of full M06. The following remain explicit future work:

- real cloud-provider verification evidence;
- real local/self-hosted model verification evidence;
- M02 model manifests, model routes, leases and persistent life runtime;
- full reconciliation resolution/polling workflow;
- cancellation of already-running provider operations;
- public search, file, code-execution and other tool adapters;
- production credential vault/KMS and production authentication.

These omissions are not hidden behind green tests.

## Verification order

Completion of this slice requires, in order:

1. inspect the final diff against the V3 M06 rules and module ownership boundaries;
2. verify frontend/machine/database contracts remain consistent;
3. only then use PostgreSQL 16 CI to prove the reviewed behavior and all prior regressions;
4. update this status to VERIFIED only on a green final PR head.
