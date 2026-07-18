# Workspace Lifecycle Hardening Plan

Status: delivered in `0.0.26`. Progress and next-step sections below are historical execution records.

## Goal

- Make any existing or new git worktree start through one fail-closed command.
- Keep DevPod identity, container environment, Compose overlay, devnet aliases, and routes aligned.
- Prevent routes from reporting ready when their upstream is missing, ambiguous, or stale.

## Non-goals

- No global repository registry.
- No new `.devrouter.yml` schema.
- No worktree deletion or automatic data-volume reset.
- No application-specific browser logic in devrouter.

## Identity

- Plan: `docs/project/2026-07-13-workspace-lifecycle-hardening-plan.md`
- Branch: `codex/workspace-lifecycle-hardening`
- Base: current `main` at `d3c97c5` after rebasing over its quality-tooling commit.
- Target: `main`
- Release target: `0.0.26`; publishing remains approval-gated.

## Research

- Evidence: `workspace up` treats DevPod startup as best-effort and registers routes afterward.
- Evidence: linked worktree commands derive tokens from branch names on every invocation.
- Evidence: DevPod already persists an ID bound to exact `source.localFolder`.
- Evidence: Compose labels expose working directory, active config files, service, mount, network, and health.
- Incident: one Klicker worktree acquired DevPod ID `escape-room-production`, branch token `codex-escape-room-production`, mixed aliases, and two route identities.

## Decisions

- Persist canonical token in worktree Git metadata; central workspace resolution reads it.
- Migrate existing worktree from unique exact-path DevPod ID; derive from branch only when no identity exists.
- Explicit/environment override differing from persisted identity fails.
- `dev workspace ensure [path]` owns attach/start/verify/reconcile.
- `workspace up` creates worktree, then delegates to `ensure`.
- New worktrees default to the repository-local ignored `trees/<workspace>` layout used by agent workflows and fail before creation when `trees/` is not ignored.
- DevPod failure blocks route changes.
- DevPod/devnet proxy targets require exact live Compose/worktree/overlay/alias proof.
- A workspace alias must resolve to exactly one running container across devnet, not merely within the expected Compose project.
- TCP upstreams must be workspace-prefixed so ownership and reachability can be proven before publication.
- Route replacement is atomic for exact worktree. Verification failure removes its routes; stale routes are never restored.
- HTTP proof polls through startup; non-5xx response proves routing. TCP proof requires unique running healthy upstream when health exists.

## Independent plan review

- Reviewer: collaboration review agent, 2026-07-13.
- Accepted: centralized persisted identity, process-group ownership, startup polling, atomic route replacement, scoped container checks.
- Rejected: separate DevPod and route tokens; one-shot curl; PID-pattern kill; unconditional container checks for arbitrary proxy upstreams; stale-route rollback.

## Progress

- Current: Slices 1-3, publication review corrections, final gates, and the clean Klicker live gate are complete locally.
- Next: publish and merge the devrouter PR, release `0.0.26`, then upgrade and revalidate the downstream Klicker branch.

## Slice 1: canonical identity

- Do: persisted token helpers and one resolver used by existing runtime and lifecycle read/teardown paths.
- Test: new/mismatch/malformed/detached/primary paths and existing command behavior.
- Check: focused Vitest, typecheck, Prettier.
- Result: canonical identity persists in worktree Git metadata; inventory and teardown ignore unrelated process overrides, support detached custom paths, and reject ambiguous identities.
- Evidence: focused tests 28/28; full tests 320/320; typecheck and build pass; `git diff --check` clean; independent correctness and simplification re-checks have no remaining blocker.
- Commit: `feat(workspace): persist worktree identity`

## Slice 2: ensure command, live preflight, and route reconciliation

- Do: exact-path DevPod discovery; CLI/handler; blocking DevPod start; exact Compose/worktree/overlay/upstream checks; lifecycle lock; atomic worktree route replacement; bounded HTTP polling; failure cleanup; `workspace up` delegation.
- Test: missing/ambiguous/wrong-worktree/wrong-overlay/wrong-token/unhealthy upstream; conflict; partial verification failure.
- Check: focused Vitest, full test/typecheck/build.
- Result: `workspace ensure` migrates or creates one exact-path DevPod identity, injects both workspace variables and Git common-dir mount input, repairs invalid containers once with `--recreate`, proves in-container Git and upstream ownership, then publishes one atomic route batch. It rejects aliases claimed by any second running container and TCP upstreams whose workspace ownership cannot be proven. Pre-start failures preserve routes; post-start proof failures clear them.
- Evidence: focused tests 57/57; full tests 337/337; typecheck/build pass; `git diff --check` clean; correctness review blockers fixed; simplification review accepted proof boundaries and removed duplicate path identity/dead inspection state.
- Commit: `fix(workspace): fail closed on invalid upstreams`

## Slice 3: docs and release artifacts

- Do: update all required command/docs/skill/example surfaces; version/changelog/upgrade prompt; smoke coverage.
- Check: docs policy, tests, typecheck, build, routing smoke; local install.
- Result: release `0.0.26` documents `workspace ensure` as the linked-worktree entry point, managed scaffolds and reference templates create a no-op primary overlay plus the Git common-directory overlay, and linked-worktree scaffold next steps select ensure automatically. Review corrections distinguish HTTP route probing from TCP upstream ownership/health proof. An already-existing exact-path DevPod whose first startup fails receives one bounded recreate, allowing pre-release containers with legacy post-start state to self-heal; brand-new DevPod failures remain fail-fast.
- Evidence: full tests 340/340; docs policy, typecheck, build, `git diff --check`, both Docker Compose overlay merges, and routing smoke pass; local CLI reports installed/config version `0.0.26`; correctness and simplification reviews have no remaining finding.
- Commit: `Release 0.0.26 -- workspace lifecycle hardening`

## Live gate

- Result: passed on 2026-07-13 against a clean latest-`origin/v3` Klicker integration worktree; the dirty Escape Room worktree and its existing DevPod/routes remained unchanged.
- Identity: persisted worktree token, exact-path DevPod ID, container `WORKSPACE`, container `DEVROUTER_WORKSPACE`, overlay mount, devnet aliases, and all ten routes agree on `codex-worktree-lifecycle-hardeni`.
- Runtime: the app container is `8d80516f34cecfe6d6a547c003c274cb5a43a91702cc96b73a919e65dbd5e051`; in-container Git resolves the exact linked worktree and PostgreSQL is healthy.
- Reachability: nine HTTPS routes returned non-5xx responses and the PostgreSQL TCP route resolved to the unique healthy upstream. A second `workspace ensure` reused the same container and application process group.
- Live-discovered corrections: Docker inspection now handles containers without a healthcheck; the managed overlay explicitly passes both identity variables into the app service; alias proof searches all running containers; unowned TCP targets fail closed. The downstream Klicker reconciler recovered an owned runtime invalidated by a production build, then a warm ensure completed in under five seconds without replacing its container or process group.
- Public push, merge, and release are explicitly approved for this task.

## Final verification

- Full Vitest suite: 36 files and 348/348 tests pass.
- Biome, Knip, docs policy, TypeScript, production build, and `git diff --check` pass.
- Opengrep ran 258 applicable rules over 185 tracked files. Its eight findings are unchanged baseline locations outside this branch diff.
- Publication review found and corrected four blockers: alias proof now inspects all Docker containers, post-start attachment failures clear routes, stale-lock reclamation uses inode-verified hard links, and the shared route-state lock no longer forcibly displaces a live owner after five seconds.
- Final thermo-nuclear maintainability review passes: the shared lock abstraction is earned, removes inconsistent duplication, and leaves all production files below 1,000 lines.
- Final security review found no high-confidence exploitable vulnerability after tracing CLI paths through Git, DevPod, Docker, filesystem metadata, locks, and route publication.

## Publication history

- Implementation and review fixes are consolidated before publication.
- The solution lesson remains a separate `docs(solutions): ...` commit.
- Version, examples, changelog, and upgrade prompt remain in the final `Release 0.0.26 -- workspace lifecycle hardening` commit.
