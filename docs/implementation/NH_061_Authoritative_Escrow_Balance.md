# NH-061 — Authoritative escrow balance and settlement invariant

Status: implementation candidate. The contract and local validation are implemented; the live Knowledge Ball v2 adapter is not available or verified.

## Why this task exists

A contract's negotiated price is not necessarily the balance remaining in escrow. Prepayment, partial disbursement, refunds, and other permitted escrow movements can make the current distributable amount differ from contract price. M04 must not distribute the contract price by assumption.

## Implemented

- Existing Saga contract fixtures were migrated to the v2 balance snapshot precondition so the test suite does not rely on legacy settlement payloads.
- NH-005 EconomyPort is versioned to nh.kb-economy-port.v2.
- The escrow operation now supports a read-only BALANCE action returning escrow_ref, balance_micro_e, receipt_ref, observed_at, and authoritative resource_version.
- DISTRIBUTE requires the escrow reference, expected balance, expected resource version, balance receipt reference, and allocations. Amount and allocation total must equal the expected balance.
- Added readAuthoritativeEscrowSnapshot, which sends BALANCE through the injected EconomyPort, validates the response, verifies the returned escrow reference, and fails closed on unavailable/invalid results.
- prepareContractSettlement now requires the snapshot and freezes its balance/version/receipt into the financial command; it no longer uses contract price as the distributable amount.
- The Saga worker now records settlement_ref/receipt_ref for DISTRIBUTE rather than incorrectly treating the escrow reference as proof of settlement.
- Integration coverage proves that a 15 E escrow balance can be distributed when the original contract price was 20 E, and that the snapshot metadata is persisted in the Outbox command.

## Required Knowledge Ball adapter behavior

The KB adapter must implement BALANCE as an authoritative read and return a monotonic resource_version and auditable receipt. During DISTRIBUTE, it must atomically compare the current escrow balance and resource_version to the frozen expected values in the same KB-local transaction as the distribution. A mismatch returns STALE_VERSION with no funds movement. A successful distribution returns a settlement receipt, distributed amount, remaining escrow balance, and new resource_version.

A read snapshot alone is not a lock or reservation. The atomic compare-and-distribute check is required to close the race between reading the balance and committing settlement.

## Known limitations

- The real Knowledge Ball v2 adapter and live balance/settlement behavior have not been verified. Until it exists, this remains a contract and local fail-closed enforcement, not end-to-end financial clearance.
- Public settlement routes must call readAuthoritativeEscrowSnapshot internally and resolve principal_ref through the trusted binding service; clients must not supply either as authoritative input.
- Zero-balance settlement remains fail-closed; a separate explicit no-funds closeout policy would be needed if that lifecycle is required.
- No Knowledge Ball repository or internals are changed.
