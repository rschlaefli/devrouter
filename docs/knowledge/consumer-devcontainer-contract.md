---
type: Integration Contract
title: Consumer devcontainer contract
description: Defines the ownership and startup contract between Devrouter and a self-contained consumer devcontainer.
owner: repository maintainers
status: active
source_paths:
  - src/core/repo-config.ts
  - src/core/managed-post-start.ts
  - src/core/workspace-ensure.ts
  - src/core/reliability-lifecycle.ts
  - src/core/managed-host-ports.ts
  - src/core/host-env.ts
  - src/commands/env.ts
  - src/core/devcontainer-*.ts
  - src/core/managed-runtime*.ts
  - src/core/status.ts
  - src/core/doctor.ts
  - src/commands/repo-devcontainer.ts
  - examples/devcontainer/**
  - docs/DEVCONTAINER.md
---

# Consumer devcontainer contract

## Purpose and ownership

A managed consumer devcontainer owns its toolchain, application dependencies, application command, and repository-specific environment setup. Devrouter owns exact-checkout reconciliation, runtime delivery of its generic process helper, network/TLS routing, and readiness proof. The current setup procedure is the canonical [devcontainer integration guide](../DEVCONTAINER.md).

Consumer images must not install, download, or version-pin Devrouter. [ADR 0002](../adr/0002-keep-devrouter-out-of-consumer-images.md) owns this boundary; the repository `.devrouter.yml` version remains the consumer-side adaptation marker.

## Managed adapter contract

`src/core/managed-post-start.ts:resolveManagedPostStartPlan` classifies the repository contract before workspace runtime startup:

- The adapter is the regular, non-symlink file `.devcontainer/post-start.sh`.
- Managed adapters contain the marker `devrouter:managed devcontainer`.
- The current adapter contract requires `DEVROUTER_PROCESS_HELPER` and uses that path to invoke the generic process supervisor.
- A custom adapter with no Devrouter lifecycle pattern remains unmanaged.
- Partial or mixed managed wiring fails with migration guidance instead of guessing.

When `postCreateCommand` is present with a managed adapter, `waitFor` must be
exactly `postCreateCommand` or `postStartCommand`; Devrouter validates this
ordering before provider mutation. Generated selective configuration preserves
lifecycle fields and changes only `runServices`.

After `workspaceEnsure` proves the exact container and in-container workspace, `runManagedPostStart` copies its matching helper and the captured adapter bytes to runtime-only paths under `/tmp/devrouter/bin`. It passes `DEVROUTER_PROCESS_HELPER` plus the adapter SHA-256 into the exact container and invokes the captured snapshot from the validated workdir. Adapter bytes therefore participate in managed-process identity without becoming an image dependency.

The adapter also receives `DEVROUTER_RUNTIME_VARIANT`. Omission and
`default` are equivalent. A non-default variant requires this managed adapter
and is part of the process identity even when the adapter supplies an explicit
fingerprint or replaces the environment allowlist.

## Selective managed resources

The optional `.devrouter.yml` `managedRuntime` registry names the primary
container's base services, optional Compose services, and repository-owned
process markers. Profiles select `apps`, `devcontainerServices`, and `processes`
independently. Base services and the primary service are always retained. In a
managed profile, an omitted optional dimension is empty, so an app-only profile
does not implicitly start an AI gateway, MCP server, mail catcher, or another
optional capability. A capability-only profile may omit `apps` and therefore
publishes no route.

The source `devcontainer.json` remains the full native configuration. For
managed startup, `ensure` creates the ignored, marker-owned
`.devcontainer/devcontainer.devrouter.json` beside it and passes that exact
path to DevPod before startup. The generated file is runtime state, not a
consumer artifact: it is never committed or hand-edited, and its content is
fingerprinted for status and drift reporting.
DevPod may add one provider-generated container-features Compose file to the
runtime project labels; exact identity accepts that known provider path but
rejects any other unconfigured overlay.

The adapter receives `DEVROUTER_PROFILE` and, for managed configurations,
`DEVROUTER_PROCESS_SET`. The process helper uses those values as non-secret
identity inputs, so a profile change replaces only the owned process set. A
warm transition retains the DevPod and volumes, starts newly selected services
without recreation, stops dropped resources only after exact ownership proof,
and publishes routes last. Inspect the result with `devrouter status` or
`devrouter doctor`.

## Runtime variants and discovered host ports

Runtime variants are a startup selector, independent of the profile's resource
set. `managedRuntime.variants` accepts at most 32 additional safe names of at
most 64 characters; `default` is implicit and reserved. `ensure` and
`workspace ensure` accept `--variant <name>`. An ordinary ensure selects
`default` without making that choice sticky. `--repair` retains the recorded
variant and rejects a different explicit selection.

Non-default variants support the manual managed lifecycle. Capacity-targeted,
enrolled, or retained capacity-managed checkouts refuse them before journal
intent, controller admission, preparation, provider mutation, or route effects.
A controller must not silently resume one as `default`. Supporting variants in
capacity estimates is a future contract.

The optional `managedRuntime.devcontainer.hostPorts` map declares TCP targets
to discover from services already registered in `baseServices` or
`profileServices`. It has at most 32 lowercase kebab-case keys of at most 64
characters. Each value contains only an exact `service` and `target` from 1 to
65535. Duplicate service/target pairs and normalized environment names are
invalid. A declared service may be non-routed, and unselected optional services
are inactive.

This registry does not start services, publish ports, allocate numbers, or create
routes. Consumer Compose owns the binding, preferably with `host_ip: 127.0.0.1`,
the declared target, and no fixed published port. Docker allocates the ephemeral
host port. Static verification accepts that loopback ephemeral form and continues
to report fixed or public publication as an error.

For every selected declaration, Devrouter resolves exactly one running container
with the checkout, Compose project, service, and configuration identity, then
accepts one actual IPv4 loopback binding for the target. It exports the current
number to the adapter as `DEVROUTER_HOST_PORT_<KEY>`, with hyphens changed to
underscores, and an empty value for an inactive declaration. A selected binding
that is missing, stopped, ambiguous, public, or unproved blocks adapter launch.

The helper includes the current declaration/status/port mapping in its identity.
A changed mapping replaces the owned process before route publication; an
unchanged mapping permits reuse. Docker can change the number on recreation, so
it is not a lease. Container clients use the service DNS name and target port;
the host number is external metadata and cannot feed the same Compose
interpolation phase.

Managed state stores a non-secret digest of declarations, never allocated port
numbers. If a failed transition changed declarations, rollback leaves the state
degraded rather than launching the previous process with candidate declarations.
Restore the retained declarations before repair. Environment export stays
unavailable after declaration drift until ensure succeeds.

`devrouter env --json` exposes an additive `hostPorts` object with service,
target, status, endpoint, and bounded reason. The command form clears inherited
`DEVROUTER_HOST_PORT_*`, exports only current available values, omits inactive
declarations, and refuses launch on a selected unavailable declaration.

## Container and network contract

- The active workspace runtime (DevPod or Devsy) must attach to the exact host checkout. Linked worktrees also mount the Git common directory at the same absolute path so the worktree `.git` pointer remains valid.
- The committed devcontainer Compose overlay supplies the workspace identity and devnet aliases used by `.devrouter.yml` proxy upstreams.
- Every managed HTTP and TCP proxy upstream begins with the resolved checkout alias namespace.
- Devrouter proves the Compose project/overlay, workspace mount, in-container Git identity, health, and globally unique aliases before route publication.
- `devrouter ensure <path>` is the only managed startup path. Direct DevPod/Devsy `up`, automatic image-time post-start, and `devrouter app run` do not provide the same proof.

## Verification and failure modes

`devrouter repo devcontainer verify --json` provides static evidence. `devrouter ensure` owns real startup and readiness; the compatibility `--live` verifier is not a startup substitute. The executable gates include `repo-config.test.ts`, `managed-post-start.test.ts`, `workspace-ensure.test.ts`, `managed-host-ports.test.ts`, `host-env.test.ts`, `devcontainer-diagnostics.test.ts`, and the env-command coverage, plus `scripts/smoke-devcontainer.sh` when Docker and a workspace runtime CLI are available.

Generated guidance is also operational code. The [generated guidance drift](../solutions/integration/generated-worktree-guidance-drift.md) record explains why lifecycle commands and scaffold defaults must stay conditional on the actual ownership model.

## Change guidance

Changes to the marker, adapter path, helper environment, overlay aliases, Git mounts, or startup order must update the generator, example, bundled onboarding skill, static verification, managed lifecycle tests, this concept, and `docs/DEVCONTAINER.md` together. Preserve helper-free image assertions and cold/warm live proof.
