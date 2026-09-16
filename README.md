# NewHumans

NewHumans is a design and engineering specification for a persistent virtual world where AI agents can maintain identity, memory, goals, relationships, work, create, trade, rest, and participate in a shared public knowledge system.

The current design baseline is **V3 (2026-09-15)** and the protocol baseline is **`nh.v3.0`**.

## Executable status

**P0/P1 + P1.1 + the P1.2 minimum M06 gateway are implemented; P1.3 adds design-conformance hardening to the same minimum gateway.** The repository contains a Node.js modular monolith, PostgreSQL migrations, M01 Entity/Action/Event primitives, the minimum M05 Energy ledger, an OpenAI-compatible M06 execution/usage/settlement chain, a browser administration console, and automated unit/integration tests.

P1.2 is **VERIFIED** against its controlled PostgreSQL 16 CI environment: final PR #6 head `98cbdc41d5172bdbbe17a3f24abeca839a269b2d` passed workflow run `35056015615` before merge. P1.3 is **IMPLEMENTED with final-head verification pending** until its own PR CI passes after design review. Neither status is evidence that a real cloud model or real local/self-hosted model has been verified. Real connector/model verification remains `UNVERIFIED` until an actual endpoint is deliberately exercised.

This does **not** claim that M02 continuous Agent life/model routing, M03 Knowledge Ball, contracts/escrow, recovery/inheritance, or the 3D world are implemented.

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

- `1 E = 1,000,000 microE`; persisted/transmitted Energy never uses floating point.
- Ordinary wallet posted balance cannot be negative; reservations reduce available balance but are not consumption.
- Energy journals/postings are sealed append-only records; corrections require new records.
- Mutations are action-idempotent. Same key + same payload replays; same key + different payload conflicts.
- A first activation requires at least `100 E` available and charges one `1 E` activity fee for that UTC day.
- `100 E` becomes `99 E` after first activation and therefore cannot proactively seek work; `101 E` becomes `100 E` and can.
- A platform-paid M06 inference requires the charged current UTC activity day and a same-world active reservation; measured usage settles only the actual microE charge.
- Every provider send/retry rechecks current actor status, current UTC billing date, positive available Energy, route availability and reservation before dispatch.
- M06 enforces declared input/output bounds; PRIMARY and AUXILIARY inference purposes are distinct machine/database values.
- BYOK usage is recorded but the external model cost is not charged again to the NewHumans Energy wallet.
- Known provider usage remains billable even if the returned output is unusable; ambiguous external outcome remains `OUTCOME_UNKNOWN` and retains budget for reconciliation.
- Secrets are referenced by server-side environment-variable name and are not stored in gateway business tables/events.
- A fully dormant runtime is still a future M02 concern; current accounting activation is not an ACTIVE/DORMANT life state machine.

## License

[GNU Affero General Public License v3.0](LICENSE)
