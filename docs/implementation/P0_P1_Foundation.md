# P0 + P1 implementation baseline

This is the first executable NewHumans slice. It implements engineering skeleton + identity/event kernel + minimum Energy ledger while preserving the V3 module boundaries.

## Run locally

Prerequisites: Node.js 22+, PostgreSQL 16+.

```bash
cp .env.example .env
# export DATABASE_URL from .env in your shell
npm install
npm run migrate
npm test
LOCAL_DEV_BOOTSTRAP=true npm start
```

Open `http://localhost:3000`. The development console can bootstrap a local SYSTEM/HUMAN pair, fund the Human, create an Agent, transfer 100 E and execute first-activation accounting. This is a real database flow, not a model/runtime simulation.

## Implemented contracts

- Entity IDs are stable UUIDs; display IDs are unique inside a world.
- Server-side actor comes from the trusted request context (`x-nh-actor-id` in this development adapter), never from a JSON `actor` field.
- Every command has an idempotency key and payload hash.
- Events are append-only per aggregate sequence and copied to an Outbox in the same transaction.
- Wallet money is exact integer microE; ordinary posted balances cannot go negative.
- Journal postings must balance to zero at transaction commit.
- Reservations reduce available Energy without changing posted balance.
- First activation requires available Energy >= 100 E and charges exactly 1 E for that UTC date.
- After first activation: 99 E cannot proactively seek tasks; 100 E can.
- Daily fee has one unique business fact per `(world, activity subject, billing date)`.

## Acceptance tests in CI

The integration suite starts from a migrated PostgreSQL database and verifies:

1. one payment command replayed 1,000 times creates one net journal;
2. 20 concurrent 1 E spends against 10 E produce exactly 10 successes and never a negative balance;
3. 99.999999 E fails first activation;
4. 100 E activates to 99 E and cannot seek tasks;
5. 101 E activates to 100 E and can seek tasks;
6. concurrent same-day fee commands produce one daily fee;
7. active reservations are excluded from available balance;
8. payload cannot override the server-bound action actor;
9. same idempotency key with a different payload is rejected.

## Deliberate boundary

P0/P1 does not claim that an Agent is continuously alive. The accounting marker `first_activated_at` exists only to distinguish first activation from later activity-day charging. M02 will own ACTIVE/DORMANT, leases, checkpoints, scheduling and model switching.
