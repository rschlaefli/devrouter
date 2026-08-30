---
type: Architecture Concept
title: Architecture and state ownership
description: Defines Devrouter's repository, provider, process, and route ownership boundaries and their canonical state.
owner: repository maintainers
status: active
source_paths:
  - src/core/router.ts
  - src/core/tls.ts
  - src/core/repo-config.ts
  - src/core/profile-resolution.ts
  - src/core/profile-plan.ts
  - src/core/workspace*.ts
  - src/core/devpod*.ts
  - src/core/devsy-agent.ts
  - src/core/host-routes.ts
  - src/core/managed-post-start.ts
  - src/core/managed-runtime*.ts
  - src/core/status.ts
  - src/core/doctor.ts
  - src/core/output.ts
  - docs/adr/**
---

# Architecture and state ownership

## Boundary

Devrouter connects repository intent to local runtime and routing systems. It does not become the source of truth for Git worktrees, application code, consumer images, or DevPod's provider inventory.

| State | Owner | Devrouter responsibility |
| --- | --- | --- |
| Repository routing intent | Consumer `.devrouter.yml` | Parse strictly through `src/core/repo-config.ts:loadRepoConfig`; never rewrite the committed file for workspace namespacing. |
| Managed profile intent | Consumer `.devrouter.yml` `managedRuntime` registry and `profiles` map | Keep base services, optional Compose services, and managed process markers explicit; resolve each profile dimension independently. |
| Automation binding intent | Consumer repository's explicit profile-plan contract | Validate exact selected resources and aggregate named literal arrays; never interpret binding semantics, expand values, execute commands, or control a runtime. |
| Git checkout and branch | Git | Inspect registered worktrees and refuse ambiguous or dirty destructive targets. |
| Managed workspace claim | Consumer Git common directory | Reconcile persisted metadata, the exact-path owner record, and both provider registries before atomically claiming one repository-local identity; no machine-global repository registry. |
| DevPod/Devsy workspace/container | Active workspace runtime provider | Mutate only an exact ID-plus-source owner through `src/core/devpod-mutation.ts` (Devsy dispatch: `src/core/devsy-mutation.ts`). |
| Verified Devsy agent source | Devrouter machine state or explicit operator environment | Pin and validate the supported asset before provider mutation; never write Devsy's private cache or the desktop app environment. |
| Effective managed Dev Container configuration | Devrouter runtime file under the consumer `.devcontainer/` | Generate the ignored, marker-owned sibling from the source configuration; pass it to DevPod before startup and never commit it. |
| Application startup command | Consumer repository adapter | Supply the runtime helper, then invoke the captured adapter through `src/core/managed-post-start.ts:runManagedPostStart`. |
| Last successful managed runtime state | Devrouter local managed-runtime state | Persist only exact identity, profile/resource sets, fingerprints, and transition status; never persist environment values or credentials. |
| Shared router files and locks | Devrouter | Keep global artifacts under `src/core/router.ts:DEVROUTER_HOME`; serialize TLS certificate inspection and refresh before publishing namespaced routes. |
| Published route generation | Traefik dynamic file | Write metadata and rendered routes as one canonical artifact through `src/core/host-routes.ts:writeRouteGeneration`. |

## Invariants and rationale

- Repository-local workspace ownership survives linked-worktree removal without a global registry. [ADR 0001](../adr/0001-repo-local-workspace-ownership.md) owns this decision.
- New linked checkouts keep the readable legacy workspace identity when it is
  unoccupied. A collision receives a deterministic hash-suffixed fallback
  before provider or route mutation; established identities are never renamed.
- Owner records and checkout metadata commit under one repository-local
  transaction. Metadata uses the shared fsync-backed atomic-file writer, so a
  crash leaves either no token or one complete token that can reconcile with
  the owner record.
- Consumer images contain no devrouter installation or version pin. [ADR 0002](../adr/0002-keep-devrouter-out-of-consumer-images.md) owns the boundary.
- Devrouter verifies the supported Devsy agent in versioned machine state and
  injects it only into CLI child processes. Devsy retains ownership of its
  workspaces, desktop registry view, and private cache. [ADR 0006](../adr/0006-devrouter-owned-devsy-agent-acquisition.md)
  owns this boundary.
- Repository lifecycle locks remain outer; workspace runtime provider mutation is serialized machine-wide and revalidated inside that boundary. [ADR 0003](../adr/0003-serialize-devpod-provider-mutations.md) owns the ordering.
- The Traefik dynamic file is canonical for one route generation; JSON is a compatibility mirror. [ADR 0004](../adr/0004-single-artifact-route-state.md) owns recovery behavior.
- The shared TLS certificate is a machine-global read-modify-write transaction. Every refresh merges the coverage already present under one lock, compacts sibling multi-label hosts into valid wildcard SANs, verifies the generated certificate, and retries once before failing closed. Concurrent worktrees cannot drop each other's hosts, while historical app routes do not grow the certificate one SAN at a time.
- Managed profile dimensions are independent. The primary service and declared base services remain active, while optional services, managed processes, and routes are selected only by the resolved profile. [ADR 0005](../adr/0005-dependency-aware-devcontainer-profiles.md) owns this boundary.
- Automation bindings stay repository-owned. Devrouter validates resource
  policy and emits deterministic literal arrays, while the consumer owns key
  meaning and command launch. [ADR 0007](../adr/0007-keep-ci-profile-planning-repository-owned.md)
  owns this boundary.
- The committed `.devrouter.yml` remains the only supported per-repository Devrouter configuration. Runtime namespacing is an in-memory view produced by `src/core/repo-config.ts:applyWorkspace`.

## Relationships

The [managed lifecycle](./managed-environment-lifecycle.md) proves exact checkout and provider ownership before the [routing contract](./routing-and-runtime-contracts.md) publishes routes. For managed consumer images, startup crosses the [devcontainer contract](./consumer-devcontainer-contract.md) only after the exact container is validated. The runtime status collector joins the selected profile, generated configuration fingerprint, exact Compose identity, process markers, and route state into one values-free diagnostic view.

## Failure modes

The dangerous failure is mixed identity: a Git checkout, workspace runtime ID, container alias, process group, and route from different generations can each look valid alone. Devrouter therefore proves the relationship at mutation boundaries and fails closed rather than repairing one layer optimistically. The incident evidence and prevention tests live in [DevPod worktree identity drift](../solutions/integration/devpod-worktree-identity-drift.md).

## Change guidance

Changes that move state between owners require an ADR when the decision is hard to reverse, surprising, and trade-off driven. At minimum, run the ownership, lifecycle, managed-post-start, route-state, and provider-mutation suites named in the [verification map](./change-and-verification-map.md).
