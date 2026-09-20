---
module: managed-runtime-isolation
date: 2026-09-20
problem_type: runtime_error
severity: high
symptoms:
  - "A container-side install writes into the host checkout and prunes the host dependency tree."
  - "The container sees host-created files under a path that is configured as a named volume."
  - "`docker inspect` still lists the named volume mount while the container's own namespace no longer has it."
root_cause: The machine's file-sharing layer unwinds a nested named-volume mount in a running container, so the workspace bind mount underneath becomes visible again.
tags: [orbstack, virtiofs, devcontainer, node-modules, isolation]
---

# A nested volume mount can disappear while its container keeps running

Status: reproduced on the machine's real provider and runtime, detected by the
profile-alternation qualification, and recoverable by restarting the exact
container; the unwinding itself belongs to the runtime and file-sharing layers,
not to devrouter.

## Problem

The devcontainer pattern this repository scaffolds shadows `node_modules` with a
named volume so host binaries cannot clobber the container's install tree
(`src/core/devcontainer-write.ts`, and item 6 of
`.agents/skills/devcontainer-onboarding/GOTCHAS.md`). On this machine the
shadowing is not durable.

In a running container the nested volume mount can disappear, leaving the
workspace bind mount visible at `node_modules` again. The container then reads
and writes the host dependency tree: a container-side install writes Linux
packages into the checkout and prunes the host's own dependencies. `docker
inspect` keeps reporting the configured volume mount, so the container looks
correct while its isolation is gone and only the container's own namespace shows
the difference.

## Evidence

All observations are from 2026-09-20 on macOS with OrbStack `29.4.0` sharing the
checkout through virtiofs and a disposable fixture whose compose shadows
`node_modules` with a named volume.

- The profile-alternation qualification failed its alternation cohort twice
  (`236df3134db4`, project `default-co-be7d2`, revision `be1e69f`; and
  `de27f0183f7f`, project `default-co-b0065`, revision `5508d13`) with a host
  checkout rewritten by the container-side install while the container's
  configured mount table still listed the volume.
- On the live fixture container `fec84c007f6e` (project `default-co-c560b`), the
  namespace reported 1 nested mount on device `41` (the btrfs volume) before the
  host install and 0 mounts on device `35` (the virtiofs host share) after it. A
  file created on the host then appeared in the container immediately, and the
  next container-side install reported `removed 1 package`, wrote
  `container-dep -> ../local-container-dep` plus `.package-lock.json` into the
  host checkout, and deleted the host's `host-dep` link.
- `devrouter exec`, `ensure --profile lean` and `ensure --profile full` on that
  container left the mount intact, and a plain `docker compose up` fixture with
  the same nested layout under `$TMPDIR` unwound it in 1 of 3 trials, so neither
  devrouter nor Devsy is required to trigger the condition.
- The hardened harness then read the namespace before the host install and found
  the volume already gone (`5986bf6476b0`, project `default-co-9c773`, revision
  `51a1cb6`), so the condition can appear with no host-side install at all.
- `docker restart <container>` re-applied the nested mount (device `41`, empty
  volume again).
- A later run of the hardened harness passed the same cell at revision
  `51a1cb6` and recorded both planes (`effectiveMountsAfterHostInstall`:
  `/workspaces/profile-alternation/node_modules` on btrfs, the workspace on
  virtiofs), which is what a healthy run looks like.

## Why devrouter does not patch this

The volume is declared by the consumer's devcontainer compose file, and the
unwinding happens inside the host file sharing and the OCI runtime. Remounting
inside the container, rewriting the mount, or recreating the container from
devrouter would either mutate runtime state devrouter does not own or hide the
condition from the operator. The durable response is detection, an actionable
message and a recovery path.

## Prevention

The [profile-alternation qualification](../../../scripts/qualify-profile-alternation.ts)
reads the running container's own namespace at the alternation cell: it checks
the configured mount table, re-reads `/proc/self/mountinfo` before and after the
host install, and fails with the container, the configured mounts and the
effective mounts when the nested volume is no longer there. Item 29 of
`.agents/skills/devcontainer-onboarding/GOTCHAS.md` carries the same check for
anyone scaffolding the pattern, and the reliability roadmap tracks a read-only
diagnostic that reports the condition from `devrouter status` or `doctor`
without blocking.

Operators who hit it restart the exact container, or leave and re-enter the
environment with `devrouter stop <path>` and `devrouter ensure <path>` for a
retained container. Treat a container-side install that rewrites the host
`node_modules` as this condition, not as a package-manager misconfiguration.
