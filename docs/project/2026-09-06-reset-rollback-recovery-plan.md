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
- Initial base: `e8f7549`. Integration commit `cfaa82a` includes target
  `0db64c1` and preserves current automatic repair and lifecycle effect fencing.
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
is complete locally. The executor stayed in reasoning without an artifact after
one narrowing checkpoint; main completed the bounded edit without a second
executor. Two regression failures were reproduced before the fix. The resulting
85 lifecycle and 43 guarded-stop tests pass; the complete suite passes 959 tests.
Typecheck, Biome, documentation policy, knowledge validation, CLI build, and
isolated package smoke pass. The reset test exercises repair from the produced
degraded record; unchanged guarded-stop tests cover coherent degraded records
and retained service cleanup separately. This is not a combined live stop proof.
This paragraph records the original pre-integration checks.

On September 8, the existing PR #56 was integrated with current main at `0db64c1`
to address the reported stale-record failure after exact provider recreation.
Conflicts preserve automatic repair and restrict rollback adapter execution to
nonempty, nondegraded prior process sets. New reset cleanup and persistence
mutations use current lifecycle claims. The integrated source passes 1,202 tests;
after adding these claims, all 143 affected ensure/stop tests pass. Typecheck,
Biome, Knip, documentation policy and knowledge validation pass. Build and package
smoke also pass after the final source changes.

The installed packed lifecycle qualifier passes at clean `cfaa82a` with tarball
SHA256 `0e9238349d16f36bf8884c9f6fd74ebf17db24d2e97d0644880a2feac0a1efaf`.
Producing receipts are `/private/tmp/devrouter-reset-current-full-tests.log`,
`/private/tmp/devrouter-reset-fenced-tests.log`,
`/private/tmp/devrouter-reset-fenced-package.log`, and
`/private/tmp/devrouter-reset-fenced-lifecycle-qualification.log`.
This uses closed synthetic providers: live-provider recovery, OOM resilience and
the original Chat 502 remain unverified. The evaluation task retains its other-host
runtime and browser ownership; this work performed no other-host mutation.

Integrated final review found no correctness, ownership, data-integrity or
architecture blocker. Its sole low-severity finding was stale plan provenance,
addressed by this update. The source result is ready for branch delivery and CI;
runtime acceptance and any release remain separate evidence boundaries.
