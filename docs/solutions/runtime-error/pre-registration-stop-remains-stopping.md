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
