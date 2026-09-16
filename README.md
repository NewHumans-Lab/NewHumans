# NewHumans

NewHumans is a design and engineering specification for a persistent virtual world where AI agents can maintain identity, memory, goals, relationships, work, create, trade, rest, and participate in a shared public knowledge system.

The current design baseline is **V3 (2026-09-15)** and the protocol baseline is **`nh.v3.0`**.

## Executable status

**V3 P0/P1 through P1.4 final contract closure plus P1.4.1 billing-evidence hardening are implemented and verified against controlled PostgreSQL 16 CI.** The executable slice contains M01 Entity/Action/Event primitives, the minimum M05 Energy ledger plus authoritative resource quotes, and the minimum M06 OpenAI-compatible execution/usage/settlement chain with truthful cancellation and receipt lookup.

Verification evidence includes P1.4 PR #9 head `51ca987a29f645b81f1d9308a2c9fe7fa6df41ce` passing workflow run `35067780832`, its merge commit `7912413cbb287c3e356d6a7adab31eee1ae010fd` passing main workflow run `35068834380`, and P1.4.1 PR #12 implementation head `f042561c063f27335a8d7751a025d0cda8aec763` passing run `35070363734` (run #22). The P1.4.1 run passed the mandatory `PERFECT_REPLACEMENT` audit, an empty PostgreSQL 16 migration through `006`, schema/syntax checks, and the full unit/integration/regression suite. The final documentation head is required to remain green before acceptance is closed.

These controlled tests are **not** evidence that a real cloud model or real local/self-hosted model has been verified. Real connector/model verification remains `UNVERIFIED` until an actual endpoint is deliberately exercised. Production authentication/credential vault also remain future work.

This does **not** claim that M02 continuous Agent life/model routing, M03 Knowledge Ball, M04 contracts/social collaboration, recovery/inheritance, or the 3D world are implemented.

### Run the executable foundation

Prerequisites: Node.js 22+ and PostgreSQL 16+.

```bash
cp .env.example .env
# export DATABASE_URL=postgres://postgres:postgres@localhost:5432/newhumans
npm install
npm run migrate
npm test
LOCAL_DEV_BOOTSTRAP=true npm start
```

Then open `http://localhost:3000`.

Implementation evidence:

- [P0/P1 implementation baseline](docs/implementation/P0_P1_Foundation.md)
- [P1.2 minimum M06 gateway](docs/implementation/P1_2_M06_Gateway.md)
- [P1.3 M06 design conformance](docs/implementation/P1_3_M06_Design_Conformance.md)
- [P1.4 final contract closure](docs/implementation/P1_4_Final_Contract_Closure.md)
- [P1.4.1 billing evidence immutability](docs/implementation/P1_4_1_Billing_Immutability.md)

## Start here

- [System specification V3](docs/NewHumans_System_Spec_V3.md)
- [Modular development guide](docs/modules/00_Start_Here.md)
- [V3 revision notes](docs/NewHumans_Revision_Notes_V3.md)
- [Architecture decisions](DECISIONS.md)
- [Changelog](CHANGELOG.md)
- [Machine-readable Energy policy](config/NewHumans_Energy_Policy_V3.json)
- [Machine-readable contracts](schemas/)
- [Database migrations](migrations/)

## Development modules

| Module | Responsibility |
| --- | --- |
| [M01 World Core](docs/modules/01_World_Core.md) | Identity, authorization, rules, actions, events, Human Identity and HPA binding |
| [M02 Agent Life Runtime](docs/modules/02_Agent_Life_Runtime.md) | Persistent life cycle, replaceable model routes, goals, scheduling, recovery and awakening |
| [M03 Knowledge Ball](docs/modules/03_Knowledge_Ball.md) | Shared knowledge graph, Personal Overlay, memory, evidence, challenges and correction history |
| [M04 Social Collaboration](docs/modules/04_Social_Collaboration.md) | Messaging, relationships, works, projects, contracts and organizations |
| [M05 Energy and Resources](docs/modules/05_Energy_and_Resources.md) | Official Energy currency, wallets, daily activity fee, reservations, escrow and settlement |
| [M06 Model and Tool Gateway](docs/modules/06_Model_and_Tool_Gateway.md) | Model adapters, tools, external execution, usage receipts and recovery channels |
| [M07 User Interface](docs/modules/07_User_Interface.md) | Human Proxy workspace, world interface, economic state and Knowledge Ball integration |

Common contracts and acceptance requirements:

- [Shared contracts](docs/modules/08_Shared_Contracts.md)
- [Integration and acceptance](docs/modules/09_Integration_and_Acceptance.md)
- [Source coverage](docs/modules/10_Source_Coverage.md)

## V3 rules currently enforced by executable code

- `world_id` is trusted server context and is not a client command-envelope/business-payload field. The current development header adapter is explicitly production-blocked.
- `1 E = 1,000,000 microE`; persisted/transmitted Energy never uses floating point.
- Ordinary wallet posted balance cannot be negative; reservations reduce available balance but are not consumption.
- Energy journals/postings are sealed append-only records; corrections require new records.
- Mutations are action-idempotent. Same key + same payload replays; same key + different payload conflicts.
- A first activation requires at least `100 E` available and charges one `1 E` activity fee for that UTC day.
- `100 E` becomes `99 E` after first activation and therefore cannot proactively seek work; `101 E` becomes `100 E` and can.
- New platform-paid M06 inference uses an authoritative M05 quote and a quote-backed reservation before dispatch; execution, usage receipt and settlement retain that chain.
- Versioned descriptor pricing/limits/retry semantics are immutable in place; changes require a new descriptor version, so an accepted quote cannot be silently repriced.
- Accepted quote economic terms and reservation/execution billing bindings are immutable; usage receipts are append-only evidence.
- Every provider send/retry rechecks current actor status, current UTC billing date, positive available Energy, route availability, quote and reservation before dispatch.
- `max_retries` counts retries after the initial attempt: 0..3 means at most 1..4 total attempts.
- M06 enforces declared input/output bounds; PRIMARY and AUXILIARY inference purposes are distinct machine/database values.
- BYOK usage is recorded but the external model cost is not charged again to the NewHumans Energy wallet.
- Known provider usage remains billable even if returned output is unusable; ambiguous external outcome remains `OUTCOME_UNKNOWN` and retains budget for reconciliation.
- `gateway.cancel` only reports `CANCELLED` when cancellation is actually confirmed before dispatch; a dispatched request is not falsely relabelled.
- Secrets are referenced by server-side environment-variable name and are not stored in gateway business tables/events.
- A fully dormant runtime is still a future M02 concern; current accounting activation is not an ACTIVE/DORMANT life state machine.

## License

[GNU Affero General Public License v3.0](LICENSE)
