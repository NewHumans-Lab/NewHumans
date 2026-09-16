# P1.2 minimum M06 gateway

Status: **IMPLEMENTED and VERIFIED** for the minimum execution gateway. The final PR #6 head `98cbdc41d5172bdbbe17a3f24abeca839a269b2d` passed PostgreSQL 16 CI (`P0-P1 CI` run `35056015615`) before merge. Real cloud/self-hosted model connections remain **UNVERIFIED** until an actual endpoint and credential are exercised; CI protocol fixtures are not presented as a real model.

P1.3 subsequently performs a design-to-code conformance review and hardens semantics that P1.2 tests did not fully enforce. See [P1.3 M06 design conformance](P1_3_M06_Design_Conformance.md).

## Why this slice exists

The V3 integration plan defines P1 as minimum M01 + M05 + M06. P0/P1 and P1.1 established/hardened M01 and M05 but deliberately excluded model execution. P1.2 closes that foundation gap before M02 owns persistent life, model routes, leases and checkpoints.

## Implemented authority boundaries

- M01 still owns Entity/Action/Event identity and idempotency.
- M05 still owns Energy reservations and final debit. M06 can request settlement through `settleReservation`; it never edits wallet balances directly.
- M06 owns descriptors, connector configuration references, executions, attempts/provider requests, usage receipts and reconciliation work.
- M02 is still absent. A descriptor/connector is execution capability, not an Agent model route or identity.

## Execution chain

```text
charged activity day
  -> active M05 reservation (platform-paid) OR BYOK declaration
  -> M01 action + M06 execution PROPOSED (short DB transaction)
  -> execution/attempt DISPATCHED (short DB transaction)
  -> provider HTTP request (NO database transaction held open)
  -> measured usage receipt
  -> M05 settlement of actual microE and release of unused reservation
  -> execution/action SUCCEEDED
```

An ambiguous timeout takes a different path:

```text
DISPATCHED -> timeout / uncertain network outcome
  -> OUTCOME_UNKNOWN
  -> reservation remains ACTIVE
  -> reconciliation job is created
  -> same idempotency key does NOT redispatch
```

## Provider protocol

P1.2 implements an OpenAI-compatible `POST /v1/chat/completions` adapter for two connector classifications:

- `CLOUD`: HTTPS is mandatory.
- `LOCAL_SELF_HOSTED`: HTTP or HTTPS is allowed because local model servers frequently expose loopback/LAN HTTP.

Both classifications use the same normalized request/usage protocol. `verification_status` defaults to `UNVERIFIED`; registering a model name does not prove the provider, weights, model snapshot or capabilities.

## Credentials

Database rows may store an environment variable **name** such as `OPENAI_API_KEY`. The secret value is read from the server process at dispatch time and is never persisted to gateway tables, Action/Event payloads, usage receipts or API results.

The development console intentionally does not accept a secret value.

## Billing

`PLATFORM_PREPAID` requires a same-world ACTIVE M05 reservation owned by the payer. The caller supplies an authorized maximum; final measured usage must not exceed it. Actual platform charge is exact integer microE:

```text
ceil(input_tokens * input_rate_micro_e_per_million / 1,000,000)
+ ceil(output_tokens * output_rate_micro_e_per_million / 1,000,000)
```

`BYOK` records trustworthy provider usage with `external_billing=true` and `charge_micro_e=0` in the NewHumans ledger, preventing double billing. The normal 1 E activity-day rule still applies.

## Retry boundary

Automatic retry is deliberately narrow in this first implementation:

- maximum three attempts;
- only when the descriptor explicitly says provider idempotency is supported;
- all attempts reuse one provider idempotency key;
- ambiguous timeout/network outcome is never automatically retried;
- a confirmed connection failure or retryable HTTP response may retry within the cap.

## HTTP endpoints

- `POST /api/v1/gateway/descriptors` — SYSTEM-only development configuration.
- `POST /api/v1/gateway/connectors` — SYSTEM-only development configuration.
- `GET /api/v1/gateway/descriptors?worldId=...` — list sanitized descriptors/connectors; no secret values or endpoint addresses.
- `POST /api/v1/gateway/infer` — execute one inference with an Idempotency-Key.
- `GET /api/v1/gateway/executions/:executionId?worldId=...` — inspect execution, attempts, receipts and reconciliation state.

Production authentication is still not claimed by this repository slice; the existing development actor-header adapter remains production-blocked.

## P1.2 CI evidence

The final PR #6 PostgreSQL integration suite verified:

1. successful platform-paid inference produces one provider dispatch, one usage receipt and an exact `RESOURCE_CHARGE` settlement;
2. unused reservation capacity becomes available after settlement;
3. replay of the same inference command never redispatches;
4. missing activity-day fee rejects before provider dispatch;
5. ambiguous timeout becomes `OUTCOME_UNKNOWN`, retains its reservation and creates reconciliation work;
6. retry uses one provider idempotency key and remains within the hard attempt cap;
7. BYOK sends a credential resolved from an environment reference, records usage and does not debit Energy twice;
8. secret values are absent from stored credential references and returned results;
9. confirmed provider failure with trustworthy usage still settles actual usage;
10. cross-world gateway references reject before dispatch;
11. all earlier P0/P1/P1.1 tests remain part of the same CI command.

The CI provider was a controlled local OpenAI-compatible HTTP fixture. This proves the implemented protocol/invariants, not the identity, weights, reliability or billing of any real external model provider.

## Still not implemented

- real-provider verification evidence for a cloud model;
- real-provider verification evidence for a local/self-hosted model;
- M02 `model_manifests` / model-route switching / persistent life loop;
- delayed provider usage polling and full reconciliation resolution workflow;
- cancellation of an already-running provider request;
- tool/code execution adapters;
- production credential vault/KMS and production authentication.
