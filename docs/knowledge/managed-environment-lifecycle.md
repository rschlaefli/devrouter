---
type: Workflow
title: Managed environment lifecycle
description: Describes exact-checkout startup, reversible stop, destructive teardown, and conservative garbage collection.
owner: repository maintainers
status: active
source_paths:
  - src/core/workspace.ts
  - src/core/workspace-lifecycle.ts
  - src/core/workspace-ownership.ts
  - src/core/workspace-ensure.ts
  - src/core/environment-stop.ts
  - src/core/workspace-gc.ts
  - src/core/devpod-mutation.ts
  - src/core/devpod-workspaces.ts
---

# Managed environment lifecycle

## Purpose and boundary

Managed lifecycle commands bind one primary or linked Git checkout to one exact DevPod/runtime generation. Use these commands instead of direct DevPod lifecycle mutations; direct provider commands do not participate in Devrouter's locks or ownership proofs.

## Startup flow

`src/core/workspace-ensure.ts:workspaceEnsure` is the canonical reconciliation path for both primary and linked checkouts:

1. Resolve the exact checkout and acquire its repository-local lifecycle lock.
2. Resolve persisted workspace identity and, for a linked checkout, write the Git-common-dir ownership record before provider startup.
3. Load the in-memory runtime config and reject any managed HTTP or TCP proxy upstream outside the checkout's alias namespace.
4. Start or attach to the exact-path DevPod through `src/core/devpod-mutation.ts:startDevpodWorkspace`, which serializes and revalidates provider ownership machine-wide.
5. Prove the expected Compose overlay, app-container mount, Git identity, health, and unique upstream aliases through `validateWorkspaceContainers` and preflight polling.
6. Run the managed repository adapter when applicable, atomically replace the checkout's proxy routes, and verify HTTP readiness.
7. Spend at most one recreate on an already-existing exact DevPod. Clear the route batch when a later proof fails.

`src/core/workspace-lifecycle.ts:workspaceUp` creates or reuses a Git worktree, then delegates startup to `workspaceEnsure`. `--no-devpod` is create-only and publishes no routes.

## Stop, delete, and inspect

| Command | Effect | Preserved state |
| --- | --- | --- |
| `devrouter stop <path>` | Stop the exact primary or linked environment and free its routes. | Checkout and linked ownership record. |
| `devrouter exec <path> -- <command>` | Execute once inside an already-running exact DevPod. | All lifecycle state; it does not start or recreate. |
| `devrouter workspace stop <target>` | Reversible stop for the resolved linked owner. | Worktree, branch, and owner record. |
| `devrouter workspace down <target>` | Delete the exact provider runtime and routes, then remove a clean unlocked worktree unless retained. | Branch; worktree and record only when explicitly retained or teardown fails before removal. |
| `devrouter workspace ls` | Join live Git, ownership, DevPod, and route evidence by exact worktree path. | Read-only. |
| `devrouter workspace gc` | Report missing-owner cleanup candidates; `--yes` revalidates and deletes only exact ledger-owned missing resources. | Git worktrees, branches, legacy/unowned resources, and conflicting owners. |

`src/core/workspace-ownership.ts:inspectWorkspaceOwnership` reports `present`, `missing`, `locked`, or `conflict`. A status is evidence for a decision; it is not permission to delete by token alone.

## Failure rules

- Ambiguous Git paths, duplicate DevPod IDs, owner conflicts, foreign aliases, dirty worktrees, and provider reassignments fail before destructive follow-up.
- Provider mutation succeeds before route removal; a failed stop/delete retains routes and ownership so the environment does not appear cleanly torn down.
- Full down removes runtime, routes, worktree, then owner record. Failures stop that sequence and preserve later state.
- Garbage collection revalidates inside one ownership transaction; a workspace revived after a dry run is not mutated.

## Evidence and change guidance

The primary behavior gates are `src/core/__tests__/workspace-ensure.test.ts`, `workspace-lifecycle.test.ts`, `workspace-ownership.test.ts`, `workspace-gc.test.ts`, and `devpod-mutation.test.ts`. Preserve their exact-path, ordering, race, and no-side-effect assertions when changing this workflow. See [architecture and ownership](./architecture-and-ownership.md) for the owner boundaries and [identity drift](../solutions/integration/devpod-worktree-identity-drift.md) for incident rationale.
