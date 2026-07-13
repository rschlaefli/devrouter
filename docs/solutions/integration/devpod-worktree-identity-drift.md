---
module: workspace-lifecycle
date: 2026-07-13
problem_type: integration
severity: high
symptoms:
  - "A linked worktree reported ready while its DevPod used another checkout or stale network aliases."
  - "Git commands failed inside an otherwise running worktree container."
  - "Routes survived a failed runtime proof and pointed at an invalid environment."
root_cause: "DevPod, Git, container, network, and route identity were derived and checked independently."
tags: [devpod, git-worktree, devcontainer, docker, routing, identity]
---

# DevPod worktrees could report ready with mixed runtime identity

## Problem

Workspace startup crossed five ownership boundaries: the linked worktree, DevPod, the app
container, Docker network aliases, and persisted routes. Checking only that processes and
containers existed allowed pieces from different worktrees to be combined into an apparently
healthy environment.

## Symptoms

- `devpod up` succeeded, but Git inside the container could not follow the worktree's `.git`
  pointer because the host common Git directory was absent.
- A running container exposed the expected alias, but another container could claim the same
  alias and make routing ambiguous.
- A failed post-start ownership check left previously published routes in place.

## What Didn't Work

- Repairing route files or container environment variables by hand fixed one layer while leaving
  the other identities free to drift again.
- Treating a successful `devpod up` exit as readiness missed wrong-path attachment, missing Git
  mounts, stale aliases, unhealthy dependencies, and unreachable routes.
- Looking only at containers from the expected Compose working directory hid foreign or standalone
  containers that claimed the same `devnet` alias.

## Solution

Persist one worktree token and use it for DevPod, container environment, aliases, and routes. Start
the exact path with the Git common directory mounted at the same absolute path, then prove the
runtime before publishing routes (`src/core/workspace-ensure.ts:430`,
`src/core/workspace-ensure.ts:477`).

Inspect every Docker container when proving alias uniqueness, while using Compose labels and mounts
only to identify the owned app container (`src/core/workspace-ensure.ts:137`,
`src/core/workspace-ensure.ts:177`, `src/core/workspace-ensure.ts:206`). Mark the environment as
started immediately after `devpod up` succeeds so any later attachment or runtime proof failure
clears the worktree's route batch (`src/core/workspace-ensure.ts:508`,
`src/core/workspace-ensure.ts:568`).

Use one file-lock primitive for workspace lifecycle and shared route-state mutations. Stale reclaim
first creates a hard link to the observed lock, then verifies the inode and link count before
unlinking it; competing reclaimers therefore cannot delete a replacement owner's lock
(`src/core/file-lock.ts:32`, `src/core/file-lock.ts:55`, `src/core/file-lock.ts:74`). Live route
owners receive a bounded wait and are never forcibly displaced (`src/core/file-lock.ts:87`,
`src/core/host-routes.ts:233`). Cleanup removes only the caller's owner token
(`src/core/file-lock.ts:133`).

## Why This Works

Readiness is now a single fail-closed proof. Every identity must resolve back to the exact worktree,
each workspace alias must have exactly one running owner across `devnet`, and routes are replaced
only after the runtime proof succeeds. Failure after a successful start removes the entire route
batch instead of preserving partially valid state.

## Prevention

The workspace lifecycle tests cover network-wide container discovery, foreign alias collisions,
post-start attachment cleanup, bounded recreate, and atomic route cleanup
(`src/core/__tests__/workspace-ensure.test.ts:105`,
`src/core/__tests__/workspace-ensure.test.ts:179`,
`src/core/__tests__/workspace-ensure.test.ts:408`,
`src/core/__tests__/workspace-ensure.test.ts:471`). Live release validation must also run
`devrouter workspace ensure .` twice and confirm the second run preserves the same container and
process group.
