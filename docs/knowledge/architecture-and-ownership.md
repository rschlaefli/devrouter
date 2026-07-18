---
type: Architecture Concept
title: Architecture and state ownership
description: Defines Devrouter's repository, provider, process, and route ownership boundaries and their canonical state.
owner: repository maintainers
status: active
source_paths:
  - src/core/router.ts
  - src/core/repo-config.ts
  - src/core/workspace*.ts
  - src/core/devpod*.ts
  - src/core/host-routes.ts
  - src/core/managed-post-start.ts
  - docs/adr/**
---

# Architecture and state ownership

## Boundary

Devrouter connects repository intent to local runtime and routing systems. It does not become the source of truth for Git worktrees, application code, consumer images, or DevPod's provider inventory.

| State | Owner | Devrouter responsibility |
| --- | --- | --- |
| Repository routing intent | Consumer `.devrouter.yml` | Parse strictly through `src/core/repo-config.ts:loadRepoConfig`; never rewrite the committed file for workspace namespacing. |
| Git checkout and branch | Git | Inspect registered worktrees and refuse ambiguous or dirty destructive targets. |
| Managed workspace claim | Consumer Git common directory | Persist one record through `src/core/workspace-ownership.ts:writeWorkspaceOwnership`; no machine-global repository registry. |
| DevPod workspace/container | DevPod provider | Mutate only an exact ID-plus-source owner through `src/core/devpod-mutation.ts`. |
| Application startup command | Consumer repository adapter | Supply the runtime helper, then invoke the captured adapter through `src/core/managed-post-start.ts:runManagedPostStart`. |
| Shared router files and locks | Devrouter | Keep global artifacts under `src/core/router.ts:DEVROUTER_HOME`. |
| Published route generation | Traefik dynamic file | Write metadata and rendered routes as one canonical artifact through `src/core/host-routes.ts:writeRouteGeneration`. |

## Invariants and rationale

- Repository-local workspace ownership survives linked-worktree removal without a global registry. [ADR 0001](../adr/0001-repo-local-workspace-ownership.md) owns this decision.
- Consumer images contain no devrouter installation or version pin. [ADR 0002](../adr/0002-keep-devrouter-out-of-consumer-images.md) owns the boundary.
- Repository lifecycle locks remain outer; DevPod provider mutation is serialized machine-wide and revalidated inside that boundary. [ADR 0003](../adr/0003-serialize-devpod-provider-mutations.md) owns the ordering.
- The Traefik dynamic file is canonical for one route generation; JSON is a compatibility mirror. [ADR 0004](../adr/0004-single-artifact-route-state.md) owns recovery behavior.
- The committed `.devrouter.yml` remains the only supported per-repository Devrouter configuration. Runtime namespacing is an in-memory view produced by `src/core/repo-config.ts:applyWorkspace`.

## Relationships

The [managed lifecycle](./managed-environment-lifecycle.md) proves exact checkout and provider ownership before the [routing contract](./routing-and-runtime-contracts.md) publishes routes. For managed consumer images, startup crosses the [devcontainer contract](./consumer-devcontainer-contract.md) only after the exact container is validated.

## Failure modes

The dangerous failure is mixed identity: a Git checkout, DevPod ID, container alias, process group, and route from different generations can each look valid alone. Devrouter therefore proves the relationship at mutation boundaries and fails closed rather than repairing one layer optimistically. The incident evidence and prevention tests live in [DevPod worktree identity drift](../solutions/integration/devpod-worktree-identity-drift.md).

## Change guidance

Changes that move state between owners require an ADR when the decision is hard to reverse, surprising, and trade-off driven. At minimum, run the ownership, lifecycle, managed-post-start, route-state, and provider-mutation suites named in the [verification map](./change-and-verification-map.md).
