# Migration namespaces

NH-014 replaces the old repository-wide "next migration number" convention with module-owned number ranges. The goal is to let independent workstreams create migrations without competing for one global counter while still preserving deterministic execution order.

## Allocated ranges

| Range | Filename token | Owner |
| --- | --- | --- |
| `0300-0399` | `m01` | M01 World Core |
| `0400-0499` | `m02` | M02 Agent Life Runtime |
| `0500-0599` | `m04` | M04 Social Collaboration |
| `0600-0699` | `m06` | M06 Model and Tool Gateway |
| `0700-0799` | `infra` | Cross-module infrastructure |

New files use exactly:

```text
NNNN_<m01|m02|m04|m06|infra>_<snake_case_slug>.sql
```

Examples:

```text
0304_m01_hpa_binding.sql
0412_m02_runtime_recovery.sql
0520_m04_project_contracts.sql
0617_m06_connector_policy.sql
0703_infra_boundary_metadata.sql
```

The numeric range and filename token must agree. `0401_m01_*.sql`, for example, is invalid because `04xx` belongs to M02.

## Frozen pre-policy history

`0001-0299` is not a pool for new work. The pre-namespace migrations already present on `main`, plus the migration files already present on open PR #17 when NH-014 was introduced, are grandfathered by exact filename. New `016_*`, `017_*`, or other attempts to continue the old global counter fail validation.

During NH-014's concurrent integration window, `0527a_m04_organization_reference_locking.sql` was merged to `main` before this guard became authoritative. Applied migration filenames must not be renamed after merge, so that single filename is frozen as an exact compatibility exception. It does **not** establish an `NNNNa` suffix convention: any other suffixed new migration remains invalid, and any duplicate four-digit migration number still fails.

These compatibility exceptions exist only to preserve already-reviewed or already-applied history. They do not reopen the old global range or weaken the new namespace format for future migrations.

## Why M03 and M05 do not receive local ranges

Under the current NewHumans boundary design, Knowledge Ball remains the authority for knowledge/memory and the legacy economy. NewHumans must not create a second local M03 or M05 authority merely to obtain a migration range. If a future approved architecture change introduces NewHumans-owned persistence for either boundary, allocate a range explicitly in this policy first.

A boundary table owned by another NewHumans module uses that module's range. A genuinely cross-module infrastructure table uses `07xx` / `infra`.

## Enforcement

`scripts/migration-policy.js` is the executable source of truth.

- Every new SQL migration must be in an allocated range and use the matching token.
- New migration filenames use exactly four digits; suffix forms such as `NNNNa_*` are rejected unless the exact filename is frozen historical state.
- A numeric migration ID may appear only once among new-format migrations, even when filenames/slugs differ.
- Unallocated ranges fail closed.
- Malformed filenames fail closed.
- `npm run check` validates the repository migration directory.
- `npm run migrate` validates names before opening the database migration run, so an invalid tree cannot bypass CI by invoking migrations directly.

There is no repository-wide "next migration" number anymore. A workstream chooses an unused slot inside its owner's range; CI is the final collision detector. If two branches choose the same slot, the later rebase fails before merge and only that module-local collision needs to be resolved.
