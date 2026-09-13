---
module: managed-devsy-stop
date: 2026-09-12
problem_type: runtime_error
severity: high
symptoms:
  - "A port conflict before provider registration leaves stop pending."
  - "Journal settlement reports already-settled while ensure remains blocked."
root_cause: Completed worker evidence does not prove that the runtime is absent.
tags: [devsy, lifecycle, ownership, absence]
---

# Startup fails before registration and stop remains pending

Status: source regression verified; consumer recovery requires separate live proof.

## Problem

Managed ensure can fail during port admission after claiming a linked checkout
but before creating its provider registration. Stop records its intent, then
cannot use the usual registration-based ownership proof. The completed worker
journal remains settled while the lifecycle phase remains stopping.

## What did not work

Repeating journal settlement cannot prove resource absence: the operation is
already completed. Treating a missing registration or executable as sufficient
would hide resources that survived an earlier partial startup. Requiring the
legacy DevPod CLI also prevents recovery on a Devsy-only installation.

## Solution

[PR 93](https://github.com/rschlaefli/devrouter/pull/93) adds a narrow absence
receipt in [managed stop](../../../src/core/managed-devsy-stop.ts). Under existing
locks it requires a present exact linked owner, no retained baseline, absent
provider registrations, positive runtime not-found, a pinned local Docker daemon
without runner or checkout containers, and no canonical or live routes. Stopped
container residue also prevents this exception.

When DevPod is uninstalled, the [legacy registry reader](../../../src/core/devpod-registry.ts)
checks every local context without creating directories. Missing or empty state
is evidence only after a complete bounded read; malformed, unreadable, partial,
symlinked, conflicting or changing state remains a refusal. It projects only ID
and local path, and never resolves a nonlocal source's empty path as the current
directory.

## Why this works

[Lifecycle settlement](../../../src/core/reliability-lifecycle.ts) compares fresh
evidence to the captured owner, daemon, legacy registry home and projection after
worker drainage. A completed operation alone cannot bypass the resource proof.
Canonical stop reports runtime absence without claiming a provider mutation.

## Prevention

[Lifecycle regressions](../../../src/core/__tests__/reliability-lifecycle.test.ts)
cover the completed-failed-startup, already-settled, blocked-ensure sequence and
next-ensure admission after proven stop. Receipt changes leave stop pending.
Provider and Docker tests cover missing tools, competing ownership, incomplete
observations and surviving resources at their narrow seams. These synthetic
checks do not prove that any particular consumer recovered.

## Cancellation after provider startup

A later startup can pass absence recovery and still be cancelled during provider
initialization, before a managed runtime baseline exists. The active journal
profile is cleared by stop, but the matching ensure entry in operation history
retains it. Reading only the active field incorrectly suggests that all profile
evidence is lost; loading the default profile then requires services that the
selected profile never requested.

Initial stop reads the exact drained ensure's historical profile under the
existing lifecycle and provider locks. It validates the selected generated
configuration, each container's recorded Compose hash, exact selected service
population, provider runner binding and pinned Docker daemon before every stop.
Own journal effect-counter increments are allowed; changes to the authority,
configuration or population refuse further effects. A stopped container that
restarts also refuses further cleanup.

This supports older interrupted starts when their operation history and full
provider proof survive. It does not manufacture a new receipt or reconstruct
all historical dispatch bytes. Missing history, incomplete population or
unreadable configuration remains a blocker; do not change the consumer default
profile, manually write state or bypass canonical stop. The invoking environment
must reproduce the original non-secret Compose inputs for hash verification.
Synthetic regression proof and read-only hash checks do not prove live cessation.

## Combined selections and first-transition rollback

Historical combined profile selections retain their original order. Initial stop
resolves them through the normal profile resolver before comparing the canonical
runtime selection. Raw journal identity and worker drainage remain unchanged;
unknown profiles and changing configuration still refuse stop.

A first transition can persist a degraded stop baseline before application startup
fails. Rewriting the generated configuration to the previously running service
subset then contradicts that retained state's attempted-profile hash. Rollback
now preserves the captured generated configuration, verifies its hash, and restores
the prior running resources. Manual generated-file drift is preserved and refused.
The legacy path without a captured baseline retains its prior behavior.

A subsequent repair still requires the original ownership and resource proofs.
Restored services or processes outside the attempted profile prevent repair.
Sequence regressions carry the first failure's state and actual generated bytes
into the retry; a compatible population reaches ready while unsafe cases refuse.

This prevention does not repair historical contradictory state automatically.
Neither plausible `runServices` contents nor timestamps prove which operation
wrote a file. Without a producing receipt, keep the checkout and retained state;
canonical stop using a valid retained stop baseline provides containment only.
There is no supported preservation-safe same-checkout resume for that legacy
configuration mismatch. Do not hand-edit generated configuration or state to
make the proof pass.
