---
module: workspace-lifecycle
date: 2026-07-14
problem_type: integration
severity: high
symptoms:
  - "A linked worktree reported ready while its DevPod used another checkout or stale network aliases."
  - "Git commands failed inside an otherwise running worktree container."
  - "Routes survived a failed runtime proof and pointed at an invalid environment."
  - "A valid container and process group kept serving HTTP 500 after a production build invalidated Next.js development output."
  - "Garbage collection could delete a workspace that was revived after the dry-run snapshot."
root_cause: "Workspace identity, container preflight, application readiness, and cleanup ownership were checked and recovered independently."
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
- Cleanup could revalidate a missing owner, then race with `workspace ensure` before deleting its
  DevPod, routes, and ownership record.

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
`src/core/workspace-ensure.ts:580`).

Spend the same single recreate budget when an existing exact workspace fails HTTP readiness:
remove its routes, recreate and reprove the container, then republish the same route batch and wait
again (`src/core/workspace-ensure.ts:557`, `src/core/workspace-ensure.ts:568`). A second failure
falls through the existing fail-closed cleanup instead of leaving routes behind.

Use one file-lock primitive for workspace lifecycle and shared route-state mutations. Stale reclaim
first creates a hard link to the observed lock, then verifies the inode and link count before
unlinking it; competing reclaimers therefore cannot delete a replacement owner's lock
(`src/core/file-lock.ts:32`, `src/core/file-lock.ts:55`, `src/core/file-lock.ts:74`). Live route
owners receive a bounded wait and are never forcibly displaced (`src/core/file-lock.ts:87`,
`src/core/host-routes.ts:233`). Cleanup removes only the caller's owner token
(`src/core/file-lock.ts:133`).

Classify DevPod ownership through one adapter that requires one exact ID-and-path pair and invokes
provider actions with argv arrays (`src/core/devpod-workspaces.ts:47`,
`src/core/devpod-workspaces.ts:88`). This keeps ensure, lifecycle, doctor, and GC on the same
fail-closed ownership rule.

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

Readiness is now a single fail-closed proof. Every identity must resolve back to the exact worktree,
each workspace alias must have exactly one running owner across `devnet`, and routes are replaced
only after the runtime proof succeeds. Failure after a successful start removes the entire route
batch instead of preserving partially valid state.

## Prevention

The workspace lifecycle tests cover network-wide container discovery, foreign alias collisions,
post-start attachment cleanup, bounded recreate, and atomic route cleanup
(`src/core/__tests__/workspace-ensure.test.ts:105`,
`src/core/__tests__/workspace-ensure.test.ts:179`,
`src/core/__tests__/workspace-ensure.test.ts:419`,
`src/core/__tests__/workspace-ensure.test.ts:482`,
`src/core/__tests__/workspace-ensure.test.ts:496`,
`src/core/__tests__/workspace-ensure.test.ts:508`,
`src/core/__tests__/workspace-ensure.test.ts:522`). Live release validation must deliberately
break application readiness, confirm one automatic recreate restores every route, then run
`devrouter workspace ensure .` again and confirm the warm run preserves the same container and
process group.

GC regression tests assert that the ownership transaction encloses DevPod, route, and record
deletion; a workspace revived after inspection is not mutated; and a busy ledger lock fails only
that candidate while later candidates continue (`src/core/__tests__/workspace-gc.test.ts:141`,
`src/core/__tests__/workspace-gc.test.ts:242`,
`src/core/__tests__/workspace-gc.test.ts:301`).
