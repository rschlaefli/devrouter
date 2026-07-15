# Devrouter workspace ownership and cleanup plan

Status: approved and executing. Date: 2026-07-15.

## Plan identity

- Path: `project/2026-07-15-workspace-ownership-cleanup-plan.md`
- Branch: `codex/workspace-ownership-cleanup`
- Worktree: `/Users/rschlae/Git/personal/devrouter/trees/workspace-ownership-cleanup`
- Target: `origin/main` at `302ac44` (`0.0.30`)
- PR: none yet
- History: `project/2026-06-25-pr-9-workspace-agent-native.md`
- ADR: `docs/adr/0001-repo-local-workspace-ownership.md`

## Goal

- Persist managed-workspace ownership after linked-worktree removal.
- Make missing ownership visible immediately in `workspace ls`.
- Separate reversible runtime stop from destructive teardown.
- Safely collect DevPod/routes left by manual Git removal or crashes.
- Keep normal routing usable outside Git repositories.

## Non-goals

- No Git hooks, watcher, daemon, branch deletion, dirty-worktree discard, or automatic `git worktree prune`.
- No global repository registry or Git requirement for non-workspace commands.
- No automatic DevPod `--force` or local-only provider bypass.
- No separate volume-retention promise for destructive `workspace down`.

## Decisions

- `workspace stop`: stop DevPod, remove routes, retain worktree, record, and data.
- `workspace down`: delete DevPod, remove routes, remove a clean worktree, then remove the record.
- `workspace down --keep-worktree`: delete DevPod/routes but retain checkout and record.
- Full down fails before side effects when the worktree is dirty or locked.
- Store records at `<git-common-dir>/devrouter/workspaces/<workspace>.json`.
- Keep the existing per-worktree token; the common record complements it.
- Records contain static ownership only: `version`, `workspace`, `worktreePath`, nullable diagnostic `branch`, `devpodId`, `createdAt`, `updatedAt`.
- Derive live runtime/route/Git state; do not persist lifecycle phases.
- Owner states: `present`, `missing`, `locked`, `conflict`.
- A Git-prunable worktree is missing. A Git-locked worktree is never collected.
- Branch changes are diagnostic only; branch targets resolve against live Git state.
- Before stop/delete/GC, require exact DevPod ID plus `source.localFolder`; an absent ID is already absent, while an ID pointing elsewhere is a conflict.
- GC reports by default and mutates only with `--yes`; it never removes worktrees, branches, or Git metadata.
- Legacy pre-ledger workspaces may be adopted by successful ensure or handled through explicit exact-evidence stop/down, but are never auto-collected.
- Remove unsafe `down --keep-devpod`; retain `--keep-worktree` because it has distinct resource-reclaim semantics.

## Research

- Git has no worktree-removal hook. `$GIT_COMMON_DIR` is the durable shared metadata boundary.
- Git common-dir output must be normalized even when older Git lacks absolute path formatting.
- DevPod stop preserves state; DevPod delete removes workspace/provider state.
- Current `0.0.30` mutates routes/runtime before dirty worktree removal fails.
- Current route state is useful evidence but not a complete ownership ledger.
- Sources: Git hooks/worktree/repository-layout documentation and DevPod stop/delete documentation.
- Limit: deletion of the entire consumer repository also deletes this ledger; whole-repository cleanup remains out of scope.

## Review

- Reviewer: Gemini 3.5 Flash High through `agy`, two passes.
- Initial blockers accepted: machine-global DevPod ID collision checks and live-branch matching.
- Simplifications accepted: no transient phase, no redundant unavailable state, no unsafe keep-devpod/local-only/force flags.
- Safety clarifications accepted: Git lock protects offline worktrees; prunable is positive missing evidence; common-dir resolution supports relative output.
- Confirmation verdict: no remaining plan blockers.

## Workflow

- Public seams: workspace CLI/core results, ownership record contract, and observable external command order.
- TDD: one failing behavioral test, minimal implementation, repeat.
- Each slice: focused checks, independent correctness review, separate simplification review, integrate findings, fresh verification, commit.
- Final: live lifecycle proof, security review, strict maintainability review, independent whole-branch review, full validation.

## Slice 1: Persist ownership before runtime creation

Do:

- Add `src/core/workspace-ownership.ts` for common-dir resolution and atomic record read/write/list/remove.
- Validate tokens, canonical paths, branch/devpod identity, schema, timestamps, duplicate ownership, and malformed records.
- Parse Git worktree porcelain including locked/prunable metadata.
- In ensure, validate config and global DevPod ownership, persist before first `devpod up`, and refresh after exact confirmation.
- Adopt exact existing `0.0.30` workspaces on ensure.
- Extend `workspace ls` text/JSON with owner, Git, DevPod source, routes, exact path, and current branch.

Check:

- Record precedes mocked DevPod start; failed proof retains it.
- Exact-path adoption works; token collisions fail closed.
- Missing/locked/conflict display without mutation.
- Focused ownership/ensure/lifecycle tests and `pnpm typecheck`.

Commit: `feat(workspace): persist workspace ownership`

## Slice 2: Separate stop from destructive down

Do:

- Add `workspace stop <workspace|branch> [--repo]`.
- Remove `--keep-devpod`; retain `--keep-worktree`.
- Resolve ledger first, then safe exact legacy fallback.
- Preflight exact owner, registered path, primary exclusion, lock, and cleanliness before full down.
- Stop: successful DevPod stop, then exact route removal; keep record.
- Down: successful DevPod delete `--ignore-not-found`, exact routes, optional worktree removal, record last.
- Treat every subprocess failure as command failure; keep retries idempotent and never use force.

Check:

- Dirty/locked full down has zero side effects.
- Stop and keep-worktree preserve intended state.
- Delete/Git failures retain retry evidence.
- Successful full down leaves no owned resource.
- Focused tests, `pnpm typecheck`, `pnpm build`.

Commit: `enhance(workspace): clarify stop and teardown semantics`

## Slice 3: Add ownership-aware garbage collection

Do:

- Add `workspace gc [--repo] [--json] [--yes]`, report-only by default.
- Inspect records against Git porcelain, filesystem, local token, DevPod registrations, and route state.
- Mutate only ledger-owned missing/prunable records after exact DevPod source validation.
- Delete DevPod without force, exact routes, then record. Never mutate Git worktrees/branches/prune state.
- Report present/locked/conflict/legacy evidence without mutation.
- Reuse the inspector in doctor with an exact remediation command.

Check:

- Dry run has zero side effects; `--yes` removes only exact eligible owners.
- Cross-repo collision, lock, conflict, and legacy cases remain untouched.
- Failed DevPod deletion retains routes/record.
- Stable JSON summary/candidate/action fields.
- Focused tests and `pnpm typecheck`.

Commit: `feat(workspace): add ownership-aware garbage collection`

## Slice 4: Prove non-Git compatibility and synchronize guidance

Do:

- Test config/app/diagnostic flows in a `.devrouter.yml` folder without `.git`.
- Make workspace commands fail early with one clear Git-required error.
- Synchronize README, AGENTS, getting started, onboarding, plan, examples, bundled skill, AI prompt, changelog-facing migration surface, and scripts.
- Document the stop/down/gc table, statuses, dirty fail-closed behavior, Git-only workspace boundary, and no-hook limitation.
- Add an isolated lifecycle smoke script using a temporary consumer repo and real DevPod when available.

Check:

- Non-Git regression and AI prompt tests.
- `pnpm check:docs-policy`, `pnpm check`, `pnpm knip`, `pnpm typecheck`.

Commit: `test(workspace): protect lifecycle compatibility`

## Slice 5: Live proof and release 0.0.31

Do:

- Run the isolated lifecycle: ensure; stop/resume; dirty-down rejection; clean full down; out-of-band Git removal; dry-run GC; mutating GC.
- Capture DevPod IDs, routes, ownership JSON, worktree porcelain, and network counts before/after.
- Add `0.0.31` package/example versions, changelog section, upgrade prompt, and current generated guidance.
- Upgrade prompt covers adoption, removed flag, config metadata, refreshed agents, and GC dry-run.

Check:

- `pnpm check:docs-policy`, `pnpm check`, `pnpm knip`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- `opengrep scan --config auto`.
- Example doctor, routing smoke, lifecycle smoke, and DevPod/devcontainer smoke plus cleanup when available.
- `npm pack --dry-run` includes runtime artifacts and excludes tests/project files.

Commit: `chore(release): publish 0.0.31 workspace cleanup`

## Final gates and publication

- Security lens: argv safety, canonicalization, exact ownership, symlink/path reuse, tampering, cross-repo collisions, deletion scope.
- Maintainability lens: module cohesion, state transitions, subprocess handling, duplicated discovery.
- Independent branch review against this plan; resolve or explicitly defer every high-confidence finding.
- Recommended PR title: `feat(workspace): add ownership-aware cleanup lifecycle` targeting `main`.
- Do not merge without explicit approval.
- After merge: wait for main CI, publish GitHub release `v0.0.31`, verify trusted npm publication and installed version.

## Progress

- Done: refreshed target and confirmed `302ac44` / `0.0.30`.
- Done: inspected lifecycle, route, Git identity, doctor, CLI, and docs surfaces.
- Done: reviewed primary Git/DevPod documentation and resolved decisions with the user.
- Done: completed two Gemini 3.5 Flash High plan reviews; no remaining blockers.
- Done: created `codex/workspace-ownership-cleanup` at the repo-local worktree above.
- Done: committed `CONTEXT.md` and ADR 0001 separately.
- Done: committed this approved plan alone.
- Done: Slice 1 storage, ensure ordering/adoption, Git evidence parsing, and ownership-aware listing implemented.
- Done: focused Slice 1 verification: 46 tests passed; `pnpm check` and `pnpm typecheck` passed.
- Done: Gemini 3.5 Flash High correctness review found one managed-as-unmanaged fallback bug; fixed by separating Git ownership from DevPod availability.
- Done: separate simplification review removed redundant row state, unified row construction, reused path comparison, and avoided duplicate common-dir discovery within writes.
- Done: committed Slice 1 as `afbd9b0` (`feat(workspace): persist workspace ownership`).
- Done: Slice 2 stop/down CLI and fail-closed lifecycle transaction implemented.
- Done: dirty and locked full down reject before side effects; keep-worktree reclaim remains allowed; exact DevPod delete/stop and record-last ordering verified.
- Done: focused Slice 2 verification: 56 tests passed; `pnpm check`, `pnpm typecheck`, and `pnpm build` passed; CLI help contains no `--keep-devpod`.
- Done: Gemini 3.5 Flash High review found no blocker; spawn errors now include Node error details.
- Done: separate simplification review consolidated managed ownership validation, isolated legacy validation, clarified transaction phases, and removed stale test/comment machinery.
- Active: commit Slice 2 after final staged diff verification.
- Next: Slice 3 red tests for read-only GC, exact eligible cleanup, conflicts, failures, JSON, and doctor reuse.
