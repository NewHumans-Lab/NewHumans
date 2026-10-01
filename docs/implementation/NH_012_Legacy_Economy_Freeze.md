# NH-012 — Legacy Economy freeze

Status: **FROZEN / LEGACY**

## Decision

The in-repository NewHumans economy implementation is no longer an extension point for new business behavior.

Legacy surfaces covered by this freeze:

- `src/services/economy.js`;
- the existing PostgreSQL `economy` schema and historical migrations that created or hardened it;
- `schemas/energy-wallet.schema.json`;
- existing HTTP/development paths that still reach the Legacy Economy for regression or development compatibility.

Knowledge Ball is the authoritative product for Economy/Energy going forward. NewHumans may consume that authority through the dedicated EconomyPort boundary; production code must not treat this Legacy Economy as a fallback when Knowledge Ball is unavailable.

## Allowed during the freeze

- Existing Legacy Economy behavior may remain so current regression coverage and development diagnostics keep working.
- Tests may import/use Legacy Economy directly.
- Existing source importers are grandfathered only to avoid breaking the current verified P0/P1/P3 regression surface:
  - `src/http/server.js`
  - `src/services/gateway.js`
  - `src/services/p1_4.js`
  - `src/services/runtime_control.js`
- Historical migrations remain immutable evidence and are not deleted by NH-012.

## Forbidden after NH-012

- New production/source modules importing `src/services/economy.js`.
- New exported Legacy Economy business operations.
- New fields or validation semantics added to `energy-wallet.schema.json`.
- New migrations that create/alter/drop or otherwise extend `economy.*` as a current business schema.
- New APIs whose purpose is to grow the Legacy Economy surface.
- Any production fallback from Knowledge Ball / EconomyPort to the Legacy Economy.

`src/services/economy.js` therefore fails closed when loaded with `NODE_ENV=production`.

## Not part of this task

NH-012 does **not** delete the Legacy Economy, historical SQL, existing callers, or existing regression tests. Removal requires a separate replacement task after the Knowledge Ball EconomyPort path is integrated and verified.

## Enforcement

`scripts/check-legacy-economy-freeze.js` is part of `npm run check`. It verifies:

1. the Legacy Economy export set remains frozen;
2. the production fail-closed guard remains present;
3. no new source importer is added outside the grandfathered set;
4. the Legacy wallet schema shape remains frozen and explicitly marked Legacy;
5. new SQL migrations do not extend the local `economy` schema.

Unit tests exercise the scanner against allowed and forbidden changes.

## Acceptance invariant

**Legacy Economy may survive for regression/dev compatibility, but it cannot grow and cannot become a production Knowledge Ball fallback.**
