---
module: workspace-lifecycle
date: 2026-07-18
problem_type: integration
severity: high
symptoms:
  - "A linked worktree reported ready while its DevPod used another checkout or stale network aliases."
  - "Git commands failed inside an otherwise running worktree container."
  - "Routes survived a failed runtime proof and pointed at an invalid environment."
  - "A DevPod ID could be reassigned between ownership inspection and an ID-only provider mutation."
  - "Route metadata and the Traefik document could describe different write generations."
  - "A valid container and process group kept serving HTTP 500 after a production build invalidated Next.js development output."
  - "Garbage collection could delete a workspace that was revived after the dry-run snapshot."
root_cause: "Checkout, provider, process, and route generations were checked or written at separate boundaries without one exact mutation identity."
tags: [devpod, git-worktree, devcontainer, docker, routing, identity, concurrency]
---

# DevPod worktrees could report ready with mixed runtime identity

## Problem

Workspace startup crosses the linked worktree, DevPod provider, app container, managed process,
Docker aliases, and published routes. Checking only that each piece exists allows different
checkout or runtime generations to be combined into an apparently healthy environment.

## Symptoms

- `devpod up` succeeded, but Git inside the container could not follow the worktree's `.git`
  pointer because the host common Git directory was absent.
- A running container exposed the expected alias, but another container could claim the same
  alias and make routing ambiguous.
- A failed post-start ownership check left previously published routes in place.
- Cleanup could revalidate a missing owner, then race with `workspace ensure` before deleting its
  DevPod, routes, and ownership record.
- HTTP routes could accept a foreign upstream namespace even though TCP ownership was strict.
- A changed managed adapter or application origin could reuse a process group created for older
  runtime inputs.
- A crash between JSON route metadata and Traefik YAML writes could make readers and Traefik act on
  different generations.

## What Didn't Work

- Repairing route files or container environment variables by hand fixed one layer while leaving
  the other identities free to drift again.
- Treating a successful `devpod up` exit as readiness missed wrong-path attachment, missing Git
  mounts, stale aliases, unhealthy dependencies, and unreachable routes.
- Treating a valid container and process group as application readiness missed corrupted Next.js
  development output, while a warm `devpod up` did not rerun the repository's post-start repair.
- Looking only at containers from the expected Compose working directory hid foreign or standalone
  containers that claimed the same `devnet` alias.
- Repeating ownership checks and conditionally removing the record did not close the cleanup race:
  the DevPod and routes had already been deleted when a changed record was detected.
- A repository-local lifecycle lock did not serialize DevPod's machine-global ID namespace across
  different repositories.
- Treating JSON as route authority did not prove which route generation Traefik actually received.

## Solution

Persist one worktree token and use it for DevPod, container environment, aliases, and routes. Before
starting anything, require every managed HTTP and TCP proxy upstream to begin with the resolved
checkout alias namespace (`src/core/workspace-ensure.ts:425`,
`src/core/workspace-ensure.ts:435`). Start the exact path with the Git common directory mounted at
the same absolute path, then prove the runtime before publishing routes
(`src/core/workspace-ensure.ts:460`, `src/core/workspace-ensure.ts:492`).

Inspect every Docker container when proving alias uniqueness, while using Compose labels and mounts
only to identify the owned app container (`src/core/workspace-ensure.ts:137`,
`src/core/workspace-ensure.ts:177`, `src/core/workspace-ensure.ts:206`). Mark the environment as
started immediately after `devpod up` succeeds so any later attachment or runtime proof failure
clears the worktree's route batch (`src/core/workspace-ensure.ts:508`,
`src/core/workspace-ensure.ts:580`).

Spend the same single recreate budget when an existing exact workspace fails HTTP readiness:
remove its routes, recreate and reprove the container, then republish the same route batch and wait
again (`src/core/workspace-ensure.ts:557`, `src/core/workspace-ensure.ts:568`). A second failure
falls through the existing fail-closed cleanup instead of leaving routes behind.

Use one file-lock primitive for workspace lifecycle and route-state mutations. Lock records include
the owner's process-birth identity, so a reused PID cannot impersonate the original owner. Live
route owners receive a bounded wait and are never forcibly displaced
(`src/core/host-routes.ts:407`, `src/core/host-routes.ts:416`).

Keep repository lifecycle locks outermost, then serialize every devrouter `up`, `stop`, and `delete`
through one machine-global provider lock (`src/core/devpod-mutation.ts:6`,
`src/core/devpod-mutation.ts:9`). Inside that lock, re-read exact DevPod ID-plus-source ownership,
perform the ID-only provider action, and prove the expected postcondition before release
(`src/core/devpod-workspaces.ts:103`, `src/core/devpod-workspaces.ts:108`). Direct `devpod` mutations
remain outside this coordination boundary and must not be used for devrouter-managed environments.

Classify DevPod ownership through one adapter that requires one exact ID-and-path pair
(`src/core/devpod-workspaces.ts:48`, `src/core/devpod-workspaces.ts:60`). This keeps ensure,
lifecycle, doctor, and GC on the same fail-closed ownership rule.

Capture the managed adapter bytes once, fingerprint that snapshot, deliver the same bytes into the
validated container, and include their SHA-256 in managed-process identity
(`src/core/managed-post-start.ts:87`, `src/core/managed-post-start.ts:118`,
`src/core/managed-post-start.ts:155`). The process helper also hashes exact argv, workspace
identity, and explicitly allowlisted non-secret environment values; adapter or origin drift restarts
only the owned group instead of reusing stale runtime state.

Make the Traefik dynamic file the canonical route artifact. Its versioned metadata header and YAML
are generated together; JSON is a compatibility mirror written first, then the canonical file is
replaced with file and parent-directory `fsync` (`src/core/host-routes.ts:205`,
`src/core/host-routes.ts:281`, `src/core/host-routes.ts:316`,
`src/core/host-routes.ts:323`). Canonical reads validate metadata against the rendered document,
migrate headerless legacy generations from validated JSON, repair stale mirrors, and fail closed on
corruption (`src/core/host-routes.ts:344`, `src/core/host-routes.ts:428`).

Serialize every ownership write or removal through one repository-wide ledger transaction
(`src/core/workspace-ownership.ts:318`, `src/core/workspace-ownership.ts:338`). GC holds that same
transaction across final record, Git, DevPod, and route revalidation; provider deletion; exact route
removal; and conditional record removal (`src/core/workspace-gc.ts:291`). A concurrent ensure either
writes first and makes revalidation block cleanup, or waits until the old resources are fully
removed. Keep dry-run inspection separate from apply so mutation always produces a fresh result
instead of mutating the snapshot report (`src/core/workspace-gc.ts:379`,
`src/core/workspace-gc.ts:398`). Transaction acquisition and per-candidate failures remain local so
later eligible candidates can still be processed.

## Why This Works

Readiness is now a single fail-closed proof. Every identity resolves to the exact worktree and
runtime generation, each workspace alias has exactly one running owner across `devnet`, and routes
are replaced only after runtime proof succeeds. Machine-global provider serialization prevents a
second devrouter process from reassigning the ID mid-mutation. Canonical route metadata identifies
the exact generation Traefik received, so recovery chooses a complete generation instead of merging
partial files.

## Prevention

The workspace lifecycle suite rejects foreign HTTP/TCP namespaces before provider or route mutation.
A real two-process test proves the machine-global provider lock blocks mutations from another
repository (`src/core/__tests__/devpod-mutation.test.ts:66`,
`src/core/__tests__/devpod-mutation.test.ts:93`). The Linux process regression proves workspace,
adapter, and allowlisted-origin drift restart the owned process while undeclared and secret values
never enter its state (`scripts/test-devrouter-process.sh:129`,
`scripts/test-devrouter-process.sh:145`, `scripts/test-devrouter-process.sh:161`,
`scripts/test-devrouter-process.sh:197`).

Route failure injection covers JSON failure, both sides of canonical rename, corrupt metadata,
legacy migration, stale-mirror repair, and real concurrent writers whose canonical metadata and YAML
retain both routes (`src/core/__tests__/host-routes-state.test.ts:225`,
`src/core/__tests__/host-routes-state.test.ts:259`,
`src/core/__tests__/host-routes-state.test.ts:296`,
`src/core/__tests__/host-routes-state.test.ts:332`,
`src/core/__tests__/host-routes-state.test.ts:351`,
`src/core/__tests__/host-routes-state.test.ts:389`).

GC regression tests assert that the ownership transaction encloses DevPod, route, and record
deletion; a workspace revived after inspection is not mutated; and a busy ledger lock fails only
that candidate while later candidates continue (`src/core/__tests__/workspace-gc.test.ts:141`,
`src/core/__tests__/workspace-gc.test.ts:242`,
`src/core/__tests__/workspace-gc.test.ts:301`).
