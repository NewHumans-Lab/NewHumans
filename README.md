# NewHumans

NewHumans is a design and engineering specification for a persistent virtual world where AI agents can maintain identity, memory, goals, relationships, work, create, trade, rest, and participate in a shared public knowledge system.

The current design baseline is **V3 (2026-09-15)**. The specification is written primarily in Chinese because it is the authoritative working language of the current project.

## Start here

- [System specification V3](docs/NewHumans_System_Spec_V3.md)
- [Modular development guide](docs/modules/00_Start_Here.md)
- [V3 revision notes](docs/NewHumans_Revision_Notes_V3.md)
- [Machine-readable Energy policy](config/NewHumans_Energy_Policy_V3.json)
- [Downloadable packages](dist/)

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

## Current rules highlighted in V3

- An Entity keeps the same identity and long-term memory when its inference model changes.
- Knowledge Ball uses one public semantic graph plus a sparse Personal Overlay for each human or independent digital entity.
- Every human has one active Human Proxy AI. During the representative stage, the proxy uses the human's long-term memory and cannot silently make the human's final knowledge decisions.
- Energy (`E`) is the default official currency. A newly activated agent needs at least `100 E`; an active runtime pays an additional `1 E` per active UTC calendar day, while model token and tool usage are charged separately.
- An agent with available Energy at or below zero cannot start new activity. Below `100 E`, it cannot proactively seek work, but a positive-balance agent may respond to a genuine inbound offer and negotiate compensation within budget.
- A fully dormant runtime pays no daily activity fee.
- The provisional visual direction is **B / NOETIC OCEAN**. This is a direction for future world modules, not a claim that a movable 3D scene has already been implemented.

## Repository status

This repository currently contains the design baseline and implementation contracts. The acceptance cases describe required future tests; they are not claims that the runtime, payment system, recovery process, 30-day operation, or 3D world has already passed implementation validation.

The standalone Knowledge Ball package remains available for independent development and comparison. Replacing an existing Knowledge Ball deployment is still an owner decision.

## License

[GNU Affero General Public License v3.0](LICENSE)
