# NH-005 EconomyPort contract

Status: authoritative NewHumans-side boundary contract for KB Economy integration.

## Boundary

NewHumans consumes Energy through one injected `EconomyPort`. Knowledge Ball Economy remains the authority for balances, eligibility, activity-day charging, quotes, reservations, settlement, transfers, escrow and ledger history. NewHumans does not read or write Knowledge Ball tables and does not maintain a shadow wallet or local-ledger fallback.

Contract version: `nh.kb-economy-port.v1`.

The port exposes exactly ten operations:

`balance`, `eligibility`, `activity_day`, `quote`, `reserve`, `release`, `settle`, `transfer`, `escrow`, `ledger`.

All cross-product identifiers are opaque references (`principal_ref`, `quote_ref`, `reservation_ref`, `contract_ref`, `receipt_ref`, `operation_ref`). Their internal storage keys are not part of this contract.

## Common envelope

Every request carries `contract_version`, `operation`, `request_id`, `idempotency_key`, `principal_ref`, optional `expected_version`, and an operation-specific `payload`. Every response echoes the contract version, operation and request id and returns an authoritative status, opaque `operation_ref`, optional monotonic `resource_version`, `result`, and `error`.

All Energy amounts are decimal integer strings in **microE**. JSON floating-point amounts are invalid. Ledger postings may be signed; spend/reserve/settle/transfer/escrow request amounts are positive.

## Operation payloads

| Operation | Minimum request payload | Minimum authoritative result |
| --- | --- | --- |
| `balance` | `{}` | posted/reserved/frozen/available microE snapshot |
| `eligibility` | `purpose` | eligibility decision, reason, available microE, activity-day status |
| `activity_day` | `billing_date` | day reference, fee microE, charged state |
| `quote` | `scope_ref`, optional `max_cost_micro_e` | quote reference, cap, expiry/fundability |
| `reserve` | `quote_ref`, `amount_micro_e` | reservation reference and reserved/available amounts |
| `release` | `reservation_ref`, optional `amount_micro_e` | released and remaining reserved amounts |
| `settle` | `reservation_ref`, `actual_cost_micro_e`, `receipt_ref` | settled amount and released remainder |
| `transfer` | `to_principal_ref`, `amount_micro_e` | transfer reference and amount |
| `escrow` | `escrow_action`, `contract_ref`, `amount_micro_e` | escrow reference/action/amount |
| `ledger` | optional `cursor`, `limit` | ordered entries, cursor and authoritative balance context |

`escrow_action` is `FUND`, `DISTRIBUTE`, or `REFUND`. `eligibility.purpose` is `ACTIVITY`, `TASK_SEEK`, `INBOUND_OFFER`, or `CONTRACT_EXECUTION`.

## Idempotency, timeout and unknown outcome

The same business attempt reuses the same `idempotency_key`. A repeated identical request returns `DUPLICATE` with the original `operation_ref` and canonical result; it does not post a second charge or transfer.

`TIMEOUT` means the caller did not receive a definitive answer before its deadline. The only safe retry is the same request with the same idempotency key. `OUTCOME_UNKNOWN` is stronger: KB Economy has an unresolved authoritative outcome and returns a `reconcile_ref`. NewHumans must reconcile that operation; it must not release funds, create a replacement transfer, or switch to a local ledger merely because the caller timed out.

Version-conflict vectors use the shared KB error code `STALE_VERSION` and carry the provider's current version so the caller can reread/re-evaluate. Balance-insufficient mutation vectors use the shared code `INSUFFICIENT_ENERGY`; that state never authorizes local credit or a synthesized negative wallet. Read-oriented operations may still succeed while showing an insufficient account condition; mutation operations fail closed when funds are required.

## Required scenario vectors

The executable contract exports test vectors for every operation covering: normal success, duplicate replay, timeout, `OUTCOME_UNKNOWN`, insufficient balance, and version conflict. These vectors are acceptance fixtures, not examples of Knowledge Ball internal persistence.

## Fail-closed dependency rule

`createEconomyPort(adapter)` requires a complete KB Economy adapter implementing all ten operations. Missing or partial adapters fail with the shared KB `UNAVAILABLE` error. There is intentionally no in-memory, PostgreSQL, cached-wallet, or local-ledger fallback in this boundary.
