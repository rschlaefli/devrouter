# Complete a partial managed Devsy shutdown

## Outcome and authority

Make canonical stop complete shutdown when Devsy already reports a stopped primary but retained services still run. Require independent proof that the complete owned project is quiescent before route cleanup. Preserve containers, volumes, configuration and ownership records.

The user's ongoing runtime-repair request authorizes this source-only follow-up: isolated source edits, tests, required reviews, local commits and status updates to the six affected tasks. Terminal is reviewed local source. Push, merge, release, installation, live repair, recreation, bootstrap, deletion and cache clearing remain withheld. The completed startup-preparation package is separate and remains unchanged.

## Baseline and ownership

Repository: /Users/rschlae/Git/personal/devrouter. Branch: rs/complete-managed-stop. Worktree: trees/rs/complete-managed-stop. Base: f4c9cddb28221a489848206877c230ba73997089. Fresh fetch confirms origin/main at this base, zero ahead and behind. No upstream integration.

Main owns managed eligibility, shutdown sequencing, route gates and integration because these share ownership evidence. A bounded executor may own the strict Docker inspection function and its tests in devpod-environment.ts and devpod-environment.test.ts. The main session owns all other files. Both paths are independently verifiable; no competing writers. Required simplifier and lifecycle slice review cover the committed implementation, followed by integrated final review.

## Contract

Preserve unmanaged/legacy and delete behavior. A retained managed state with missing registration, malformed configuration or conflicting ownership fails closed, including the no-provider branch in environment stop. Do not convert such a case to absent and remove routes.

Use the existing workspace-then-provider lock order. Validate fresh provider selection, exact registration, linked owner, recorded provider ID and source path. Reconstruct the recorded profile and compare desired app/service/process sets and source/effective/generated configuration. The required service population is plan.desiredServices, including primary/base services. Additional retained services must belong to plan.nativeRunServices, with one container per service.

Add a narrow strict inspection entry point. List the exact project using full IDs, inspect that explicit population, require exact requested/returned set equality, and independently relist to reject membership changes. Reject malformed/duplicate IDs, records, missing fields, command errors, timeouts and buffer failures. Do not filter invalid or foreign members out before validation. Validate state status and flags: running is consistent; exited and never-started created are quiescent. Paused, restarting, dead, removing, unknown or contradictory state fails closed.

Validate every captured ID's exact Compose project, working directory, ordered file list, service and configuration hash. Require the primary's exact source bind mount. Feature-generated Compose files must stay inside the trusted Devsy root/context/workspace agent directory without symlink escape. Derive context from fresh Workspace.context metadata and require it unchanged. Devsy's macOS/Linux root is nonempty DEVSY_HOME or ~/.devsy; no secret configuration is read. Preserve legacy parsing when context is absent, but reject that evidence for managed stop.

If provider and primary are both stopped/quiescent, skip the provider stop that would reject this state. If both are running, call it once. Disagreement, busy, unknown, absent or invalid evidence fails without residual cleanup or route removal. Catch only that provider call's failure, then reread all evidence under the same locks.

Residual cleanup requires unchanged ownership/configuration/membership, stopped provider and quiescent primary. Stop only captured running IDs, once each, revalidating before every mutation. Stop further cleanup on proof or stop failure. Never substitute replacements or broaden the project. Final proof requires unchanged full membership, all containers quiescent and fresh exact provider ownership/status.

Always rethrow the original provider failure, attaching any secondary failure without replacing it, even if eligible residual cleanup succeeded. Routes stay untouched on this error. A later canonical stop can complete route cleanup. Only successful full-stop proof permits existing route removal and generation verification; route verification failure stays nonzero. Reset provider caches before fresh reads and in the stop dispatcher's finally block.

## Verification

Strict inspection tests cover population equality, malformed/omitted/duplicate/unexpected records, transport failure, state consistency and changing membership using full synthetic IDs. Managed stop tests cover stopped-primary/running-service recovery, normal stop, idempotency, eligible/ineligible cleanup after provider failure, ownership/context/config/membership drift, wrong or symlinked generated paths, replacement and failed exact stop. Lifecycle tests cover missing registration, cache invalidation on failure, both locks spanning proof and mutation, route gating and later verification recovery. Preserve existing legacy/delete coverage.

Run focused tests, then repository-native static checks, full tests, build and package checks in disposable toolchain containers. Mocked evidence is sufficient for this source terminal; no live consumer or routing smoke starts. Reopen verification only for a concrete unresolved Docker/Devsy assumption. Inspect staged content, commit locally and obtain required independent reviews. Stop task-owned test containers.

## Progress

Native planner 01a072c3-85a8-7981-9692-cda9d8933870 approved after incorporating inspection completeness, managed eligibility, precise states, preserved provider failures and trusted context/path provenance. Official Devsy v1.16.2 source supplies the path contract; v1.17.0 still rejects stopping a non-running primary. One targeted values-free read confirmed the affected UX workspace emits its context. No implementation, live mutation or source-package review has run yet.
