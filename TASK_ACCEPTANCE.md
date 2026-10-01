# Task Self-Acceptance Protocol

This protocol is the repository-wide completion gate for independently executed task cards. It supplements design conformance and `PERFECT_REPLACEMENT`; it never overrides them.

## Required lifecycle

Every task uses an isolated branch and follows this order:

1. claim exactly one task;
2. branch from current `main`;
3. change only the authorized scope;
4. implement and add task-owned tests;
5. run `npm run check`;
6. run `npm test`;
7. rebase/rebuild the task branch on the latest `main`;
8. rerun acceptance on the final head;
9. review the final diff and record `Self-Review: APPROVED`;
10. open the PR with the machine-readable Task Acceptance block;
11. merge only when required CI is green and acceptance is passing;
12. replace `Merge-SHA: PENDING` in the merged PR body with the exact 40-character GitHub merge commit SHA;
13. rerun/observe the final Task Acceptance check, then mark the task `MERGED + VERIFIED` and delete the task branch.

A failed test, checker, scope audit, design audit, replacement audit, or required CI job blocks merge. A task is not `VERIFIED` merely because GitHub accepted a merge.

## Canonical machine-readable block

The canonical copy/paste template is [`.github/task_acceptance_template.md`](.github/task_acceptance_template.md). The same labels are embedded in the repository PR template.

Required fields, each exactly once:

- `Task-ID`: stable task identifier, for example `NH-018`;
- `Scope`: concrete statement of the files/behavior authorized by the task;
- `Tests`: concrete commands/evidence run for this task;
- `Self-Review`: must be exactly `APPROVED`;
- `Known-Limitations`: `NONE` or a concrete limitation statement; placeholders such as `TODO`, `TBD`, `PENDING`, or `N/A` are invalid;
- `Merge-SHA`: must be `PENDING` before merge, then the exact 40-character merge commit SHA after merge.

The checker is fail-closed for missing or duplicate fields. `Scope` and `Tests` must contain concrete values. Final verification also rejects a merge SHA that does not match GitHub's `merge_commit_sha` from the merged PR event.

## Traceability invariant

The PR is the task's audit envelope:

- `Task-ID` identifies the task card;
- `Scope` plus the PR diff identifies what changed;
- `Tests` identifies the verification evidence;
- `Self-Review: APPROVED` records the executor's final diff review;
- GitHub CI records machine execution results;
- the merged PR records the exact merge commit, and the final `Merge-SHA` field must match it.

Therefore a completed task can be traced from task ID -> authorized scope -> diff -> tests -> self-review -> CI -> merge commit.

## Machine enforcement

`scripts/check-task-acceptance.js` reads the GitHub pull-request event payload.

- Open PRs are checked in **premerge** mode and require `Merge-SHA: PENDING`.
- Merged PRs are checked in **final** mode and require the exact 40-character `merge_commit_sha`.
- Missing, duplicate, placeholder, or contradictory fields return a non-zero exit status.

`.github/workflows/task-acceptance.yml` runs the checker for PR creation, edits, updates, reopening, and closure. The `edited` event is intentionally included so the executor can replace `PENDING` with the real merge SHA after merge and obtain the final green acceptance result.

## Scope of this protocol

Task Acceptance proves task execution traceability. It does not certify product semantics by itself. The repository's authoritative design, module ownership rules, security/accounting invariants, `PERFECT_REPLACEMENT` audit, regression tests, and required CI remain independent gates.
