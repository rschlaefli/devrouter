---
module: managed-stop-recovery
date: 2026-09-20
problem_type: runtime_error
severity: high
symptoms:
  - "A retained managed runtime whose generated profile was removed refuses every provider mutation."
  - "Stop fails with `devcontainer path .../devcontainer.devrouter.json does not exist` and cannot settle."
  - "The journal stays in stopping with a COMPLETED ensure, so settlement answers already-settled and ensure stays blocked."
root_cause: The stop path assumed its ignored generated profile still existed, while the provider resolves that recorded path before it mutates anything.
tags: [devsy, lifecycle, generated-profile, stop-recovery]
---

# A removed generated profile blocks stop and every later ensure

Status: source, regression and live local recovery verified on a disposable
fixture; publication and consumer-side recovery remain separate.

## Problem

Devrouter registers a managed environment with the provider through an ignored
sibling of the repository's `devcontainer.json`
(`.devcontainer/devcontainer.devrouter.json`), and Devsy resolves a workspace's
container configuration from that recorded relative path before every provider
action. An interrupted or rolled-back transition, an operator cleanup, or a
consumer tool that treats the file as build output can remove it while the
registration and the retained runtime survive.

The provider then refuses both stop and delete with `devcontainer path
<checkout>/.devcontainer/devcontainer.devrouter.json does not exist`. The stop
worker fails before its own proofs run, so the journal stays at `desired:
stopped-by-user, phase: stopping`, `devrouter workspace journal settle` reports
`already-settled` because the ensure operation it would join is already
`COMPLETED`, and lifecycle admission blocks every later `ensure` with `Lifecycle
admission is blocked. phase is 'stopping'`.

## What did not work

Repeating settlement joins an operation that has already completed, so it cannot
drain the stop. Relaxing the provider path check would ask the provider to mutate
a workspace whose configuration it cannot read. Regenerating the profile from the
current source would silently accept a configuration the provider never
registered, and hand-editing the provider registration is not a supported
mutation path.

## Solution

[`restoreRecordedManagedDevcontainerConfig`](../../../src/core/managed-devsy-stop.ts)
re-runs the managed profile resolver against the retained runtime state and
restores the exact generated artifact only when all of these hold:

- the checkout has a `.devrouter.yml` and a readable managed runtime record
- the record's profile and workspace token still resolve to the same values
- the generated file is positively `missing`, not unreadable or different
- the current source reproduces the recorded `sourceConfigSha256` and
  `effectiveConfigSha256`

Every Devsy provider mutation calls it inside the provider mutation lock and
before the stop proof or any provider action, so the provider always sees the path
it registered. The restore is opportunistic: a missing record, an unreadable
record, a changed source or a non-managed checkout leaves the file and the
environment untouched, and the caller's ownership, population and identity proofs
still decide whether anything may proceed.

## Why this works

The retained state is the only durable record of what was registered, and both
fingerprints bind the restore to the source and effective configuration that the
record describes. Restoring therefore cannot authenticate new content: it either
reproduces the recorded artifact or does nothing at all. A write that still fails
the generated-config inspection refuses with `Managed Dev Container path
'<path>' could not be restored from the recorded state.` instead of letting the
provider run against a half-written file.

## Prevention

[Managed stop regressions](../../../src/core/__tests__/managed-devsy-stop.test.ts)
cover the restore plus a changed source, an unreadable record, a non-managed
checkout and the existing refusals, and
[Devsy mutation regressions](../../../src/core/__tests__/devsy-mutation.test.ts)
cover the restore running before both the stop proof and the provider action. The
[profile-alternation qualification](../../../scripts/qualify-profile-alternation.ts)
ends with a `generated-profile-restore` cohort that removes the file after the
environment exists and requires `stop --delete` to restore it, remove the exact
container and route, and settle the journal.

## Live receipts

A stuck primary fixture reproduced the original symptom: `ensure` had completed,
the generated profile had been removed after the transition, and `stop --delete`
refused with `devcontainer path ... does not exist` while `workspace journal
settle` answered `already-settled`/`COMPLETED`. A rebuild carrying the fix
returned exit 0 with `{"kind": "primary", "stopped": false, "deleted": true,
"freedRoutes": 1}`, moved the journal to `phase: idle`,
`desired: stopped-by-user` with `stopProof: {workloadsStopped: true,
routesRemoved: true}`, and left no Devsy registration for the checkout. A full
`ensure` followed by another removal and `stop --delete` returned the same
payload.

The qualification run measured at source revision `5508d13` with `dirty: false`
and bundle hash `6de1b11e3073e81a980d27b707276bf64bc0983c9accf8ad6dfd66485a2c4ff0`
included that cohort on one retained container whose ID never changed.
