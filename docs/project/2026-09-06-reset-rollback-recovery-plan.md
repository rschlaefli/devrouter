# Recoverable rollback after an external runtime reset

## Approval summary

An external container reset can leave a saved ready runtime record behind.
When recreation fails, devrouter restores a base-only configuration but retains
that stale record. Repair and stop then reject the mismatch. This fix keeps
failed recreation recoverable without weakening ownership checks or deleting
retained data. The user approved implementation and a later task-only retry.

Preserve the exact candidate configuration and record it as degraded only after
proving its owner and complete service population. Quiesce candidate processes
and remove unusable routes for this checkout. Do not invoke the full-profile
startup hook when there are no previous processes to restore. Existing warm
rollback behavior remains unchanged.

Local edits, checks, reviews, and commits are authorized. Release, global
installation, publication, merge, manual runtime-state edits, and deletion are
excluded. A tested local CLI may later retry the isolated Klicker task once.
Incomplete ownership or population remains an explicit recovery boundary.

## Execution details

- Worktree: `trees/rs/reset-rollback-recovery`; branch `rs/reset-rollback-recovery`.
- Base: `e8f7549`, matching refreshed `origin/main`; no upstream integration.
- Package: one full-path regression fix; no new schema or command surface.
- Documentation: update the managed environment lifecycle knowledge page only
  where recovery semantics change. No release artifacts or new architecture.
- Boundary owner: main session. Terminal: reviewed local source and checks,
  followed by one isolated runtime retry or a concrete capability boundary.

### Ownership and sequence

The executor owns bounded source, synthetic regression tests, and necessary
documentation. Main owns recovery decisions, exact diff verification, commits,
required slice and final reviews, and the later live retry. Preserve unrelated
worktrees and the installed CLI.

### Binding recovery contract

Distinguish saved history from a proven live rollback baseline. Positive exact
project absence invalidates the old healthy baseline; inspection failures stay
fail-closed. After exact candidate ownership and complete population proof,
retain matching config, profile, resource sets, fingerprints, and identities as
degraded. Remove both stale pre-reset and candidate routes, even when failure
precedes publication. Scope all actions to the exact checkout. Do not fabricate
repairability before candidate proof. Report state or cleanup failure explicitly.
Skip the rollback post-start hook for an empty previous process set; preserve
nonempty warm restoration and all ownership checks.

### Verification

Extend existing lifecycle fixtures, not prose or snapshot tests. Cover reset plus
HTTP failure, coherent degraded state and no unusable routes, recovery through
existing repair and stop, cold rollback without transient full starts, failures
before publication or complete population, persistence/removal failures, and
ownership inspection failure. Reuse warm regression coverage. Require reproduced
red/green tests, focused lifecycle suites, native checks and build/package checks
where runnable. Source tests do not prove the original Chat 502 resolved.

## Progress

Planner approved the revised contract on September 6. Unchanged lifecycle
baseline passes 79 tests under Node 24.16.0. Dependencies are installed from the
lockfile; no application runtime was started for this source work. Implementation
and required source reviews remain pending.
