# Restore managed local runtimes

## Approval summary

Devrouter can misclassify an owned process as foreign, then retain a degraded runtime record that ordinary ensure cannot repair. Correct the helper and add explicit `ensure --repair` for the recorded profile. Ordinary ensure keeps its existing behavior. A separate Klicker change preserves the container's Python selection through Turbo.

Approval permits implementation, repository checks, required independent reviews, and local commits on the existing task branches. It does not permit installation, live repair, messaging, process cancellation, push, merge, deletion, or shared router restarts. Those actions require approval of the tested result and exact targets.

Repair replays the current repository adapter. It may replace exactly owned process groups and start retained stopped containers and services. Failure can leave owned resources running and cannot restore earlier adapter bytes. Containers, volumes, foreign resources, and unrelated routes must remain intact. No recreation or first-time adoption is permitted. Completion means passing behavioral checks and reviewed local commits, ready for a separate installation decision.

## Execution details

### Ownership and baseline

Devrouter worktree: `/Users/rschlae/Git/personal/devrouter/trees/rs/fix-managed-process-ownership`, branch `rs/fix-managed-process-ownership`, baseline `93acdcae80be4688bd792ed3256e2e37b5e47ede`, tracks origin/main, initially equal.

Klicker worktree: `/Users/rschlae/Git/klicker/klicker-uzh/trees/rs/fix-devcontainer-python-selection`, branch `rs/fix-devcontainer-python-selection`, baseline `fbc5f4fcc2ffa1c8d25695679823134985c5a8d8`, tracks origin/v3, initially equal. No upstream integration is authorized.

### Delegation Map

| Work | Owner | Acceptance |
|---|---|---|
| Helper correction | executor; main integrates existing patch | Linux lifecycle regression fails installed helper and passes corrected helper; foreign-process refusal retained. |
| Guarded repair | main owns eligibility and rollback; executor implements settled independent command forwarding/tests | Acceptance matrix below passes without weakening ownership. Coupled state decisions stay with main. |
| Python selection | main; delegation costs more than this one-line correction | Actual Turbo strict-mode process receives UV_PYTHON and changing it changes task hash. |
| Verification | simplifier and slice-reviewer for substantive Devrouter slice; final-reviewer after integration | Findings dispositioned, focused checks pass, exact diff reviewed. |

### Repair contract

Both ensure aliases expose `--repair`. Under the existing workspace lock, read the persisted record before detachment handling. Only a valid degraded managed record qualifies. Omitted profile uses its recorded canonical profile. Absent, corrupt, legacy, ready, foreign, or unreadable state rejects before any mutation-capable rollback boundary.

Require exact provider registration, workspace, Compose project and retained primary/required containers. Compare canonical profile, all desired app/service/process sets, source/effective Dev Container hashes, and generated-file ownership/content even when stopped. These hashes do not cover all Compose contents or adapter inputs; validate retained container configuration separately. Missing containers or configuration requiring recreation rejects.

Reject unexpected active managed resources before replay. Preserve PID/group/fingerprint guards. Replay current adapter inputs; reuse a process only when its current fingerprint matches. Start only retained exact services through the no-recreate/no-dependencies path, and revalidate container identities after startup. If provider startup could recreate or rerun destructive bootstrap, reject instead of starting it.

Retain degraded persistence while checking the candidate runtime and publishing its routes. Use structured candidate status validation, not prose matching. Verify services, processes, ownership, and route readiness; atomically persist ready last. On every failure retain or restore degraded status. Guarded rollback may run current adapter code and leave owned resources running; report concrete failures without claiming previous state restoration.

### Acceptance matrix

| Scenario | Required result |
|---|---|
| Ordinary ensure and both aliases | Existing degraded rejection and option forwarding remain correct. |
| Invalid repair baseline | Profile/resource/config drift, foreign generated files, missing containers, unreadable ownership and non-degraded state fail before runtime mutations. |
| Running or retained stopped runtime | Matching groups retained; changed adapter fingerprints replace only owned groups; container identities preserved; readiness precedes ready persistence. |
| Failure injection | Startup, adapter, service, route publication, final inspection, and state persistence failures remain degraded; unrelated resources/routes remain untouched. |
| Concurrency | Repair, ensure and stop retain existing workspace and provider serialization. |

Use existing ensure/status/CLI tests with synthetic fixtures, native formatting/type checks, build and packaging checks. Run container-dependent toolchains in disposable task-owned containers. Reuse already-passing helper and Turbo evidence while their inputs remain unchanged. Review staged content before each local commit. Record the reviewed plan first, then scoped fix commits. Stop only task-owned test runtimes after final verification.

### Separate live boundary

Potential later repair targets are the exact response-example and v3-release workspaces, subject to fresh owner checks. Live commands, helper installation paths, replay effects, and any stopped-runtime startup must be presented after implementation and review. The machine-global queue was blocked by a long-running unrelated bootstrap and subsequently cleared without our intervention; interruption requires separate approval and fresh process identity checks. Queue cancellation and further Rollup diagnosis remain outside this source plan.

## Progress and review provenance

Prepared, uncommitted: four helper pipeline corrections and a large-environment lifecycle regression; one-line Turbo globalEnv correction. Helper suite passes corrected code and fails the installed baseline. Turbo strict-environment and hash proof passes. No local installation or live repair has occurred.

Planner rounds one and two requested changes to recovery. Accepted: explicit repair, pre-detachment eligibility, stopped-state checks, preflight outside rollback, current-adapter replay disclosure, ready-last validation, and retained-container-only startup. The final draft incorporates those constraints. Human approved source implementation, checks, reviews, and local commits on 2026-09-05 with "so proceed fixing that". Optional cross-provider pass is not run because its prerequisite committed review scope is not yet authorized; this limitation does not replace the native planner gate.

Final native planner round: APPROVED. The original reviewer could not be resumed (terminal not_found); a fresh planner using the same native role reviewed the frozen draft and accepted all incorporated constraints. This is technical review, not human execution authority.
