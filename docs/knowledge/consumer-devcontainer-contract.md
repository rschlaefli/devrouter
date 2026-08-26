---
type: Integration Contract
title: Consumer devcontainer contract
description: Defines the ownership and startup contract between Devrouter and a self-contained consumer devcontainer.
owner: repository maintainers
status: active
source_paths:
  - src/core/managed-post-start.ts
  - src/core/workspace-ensure.ts
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

`src/core/managed-post-start.ts:resolveManagedPostStartPlan` classifies the repository contract before DevPod startup:

- The adapter is the regular, non-symlink file `.devcontainer/post-start.sh`.
- Managed adapters contain the marker `devrouter:managed devcontainer`.
- The current adapter contract requires `DEVROUTER_PROCESS_HELPER` and uses that path to invoke the generic process supervisor.
- A custom adapter with no Devrouter lifecycle pattern remains unmanaged.
- Partial or mixed managed wiring fails with migration guidance instead of guessing.

After `workspaceEnsure` proves the exact container and in-container workspace, `runManagedPostStart` copies its matching helper and the captured adapter bytes to runtime-only paths under `/tmp/devrouter/bin`. It passes `DEVROUTER_PROCESS_HELPER` plus the adapter SHA-256 into the exact container and invokes the captured snapshot from the validated workdir. Adapter bytes therefore participate in managed-process identity without becoming an image dependency.

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

## Container and network contract

- DevPod must attach to the exact host checkout. Linked worktrees also mount the Git common directory at the same absolute path so the worktree `.git` pointer remains valid.
- The committed devcontainer Compose overlay supplies the workspace identity and devnet aliases used by `.devrouter.yml` proxy upstreams.
- Every managed HTTP and TCP proxy upstream begins with the resolved checkout alias namespace.
- Devrouter proves the Compose project/overlay, workspace mount, in-container Git identity, health, and globally unique aliases before route publication.
- `devrouter ensure <path>` is the only managed startup path. Direct `devpod up`, automatic image-time post-start, and `devrouter app run` do not provide the same proof.

## Verification and failure modes

`devrouter repo devcontainer verify --json` provides static evidence. `devrouter ensure` owns real startup and readiness; the compatibility `--live` verifier is not a startup substitute. The executable gates are `src/core/__tests__/managed-post-start.test.ts`, `workspace-ensure.test.ts`, and `devcontainer-verify.test.ts`, plus `scripts/smoke-devcontainer.sh` when Docker and DevPod are available.

Generated guidance is also operational code. The [generated guidance drift](../solutions/integration/generated-worktree-guidance-drift.md) record explains why lifecycle commands and scaffold defaults must stay conditional on the actual ownership model.

## Change guidance

Changes to the marker, adapter path, helper environment, overlay aliases, Git mounts, or startup order must update the generator, example, bundled onboarding skill, static verification, managed lifecycle tests, this concept, and `docs/DEVCONTAINER.md` together. Preserve helper-free image assertions and cold/warm live proof.
