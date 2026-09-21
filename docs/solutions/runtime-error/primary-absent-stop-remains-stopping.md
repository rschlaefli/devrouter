---
module: managed-stop-recovery
date: 2026-09-20
problem_type: runtime_error
severity: high
symptoms:
  - "A primary checkout whose retained managed container was pruned cannot finish stop."
  - "stop --delete removes the Devsy registration and then fails settlement."
  - "The journal stays in stopping with an already-completed ensure, so ensure stays blocked."
root_cause: The absent-registration stop proof required a linked-workspace ledger record that a primary checkout cannot have.
tags: [devsy, lifecycle, absence, stop-recovery]
---

# A primary checkout cannot settle an absent managed registration

Status: source, regression and live local recovery verified on a disposable
fixture; publication and consumer-side recovery remain separate.

## Problem

A managed Devsy primary checkout records a stop baseline for its exact container
population. An external prune or a guard-ordered `stop --delete` can then remove
the container, and `--delete` can also remove the Devsy registration. Stop has to
prove that the runtime really is absent before it clears the journal, because the
completed ensure operation is not evidence of absence.

The absent-registration proof accepted only ledger-owned linked checkouts, so both
shapes failed closed in the worst way on a primary checkout: the proof threw
`Absent stop requires a linked workspace.` after the registration was already
gone. The journal stayed at `desired: stopped-by-user, phase: stopping,
stopProof: {workloadsStopped: false, routesRemoved: false}`, `workspace journal
settle` reported `already-settled` because the ensure operation was `COMPLETED`,
and lifecycle admission then blocked every later `ensure`.

## What did not work

Repeating settlement cannot drain a stop whose worker is gone, because the
operation it would join is already complete. Relaxing the population checks would
let a surviving or replaced workload be reported as a completed stop. Treating a
missing registration as sufficient evidence would accept a checkout whose
containers still run. The [earlier absence plan](../../project/2026-09-09-absent-runtime-stop-plan.md)
deliberately scoped its exception to ledger-owned linked checkouts; the primary
checkout needs equivalent identity evidence rather than a weaker proof.

## Solution

[managed stop recovery](../../../src/core/managed-stop-recovery.ts) now returns a
discriminated absent-registration identity. A linked checkout still proves the
workspace record, worktree path, Git ownership and Git common directory. A
primary checkout proves the same thing with the identity the baseline already
recorded: the exact checkout path and provider ID (with the retained context and
UID) must match the one registration that was captured at capture time, and the
checkout must resolve to the Devsy provider.

Both shapes keep every existing fail-closed check. Both provider registries must
stay readable and clear of that exact ID and path; the saved daemon and endpoint
must be unchanged; every saved container ID must be positively absent; the
Compose project, Compose directory and provider-runner populations must be empty
across two stable observations; the retained generation must be unchanged; and
the retained baseline plus interrupted history survive. An inconsistent pair
(linked checkout without a retained workspace, or a primary checkout with one)
throws `Absent stop requires the exact workspace identity.` instead of choosing a
proof.

The same change lets an unchanged registration whose whole population was pruned
settle a primary checkout, because that branch re-checks the exact registration
identity, endpoint, daemon, provider selection and absent populations before it
reports `proven-absent`.

## Why this works

A primary checkout has no ownership ledger by construction, so the retained stop
baseline is the only durable record of which runtime it owned. Binding the proof
to that record, and re-reading the live registry between two observations, gives
the same guarantee the ledger gives a linked checkout: the absent ID and path
cannot be re-registered, replaced or reused with different identity while the
proof runs. Because the proof performs no provider or container mutation, a
refusal leaves the state exactly as it was, and a success only frees routes and
settles the journal.

## Prevention

[Stop-recovery regressions](../../../src/core/__tests__/managed-stop-recovery.test.ts)
cover the proven primary checkout, a competing registration, a linked checkout
with no retained workspace identity, a primary checkout with one, and the
existing linked, replacement and uncertainty refusals. The
[preparation-reuse qualification](../../../scripts/qualify-process-preparation.ts)
runs six cohorts on one disposable primary fixture and asserts first-attempt exit
codes, preparation counts, process identity, route readiness and the
stop-then-ensure recovery, so the primary path is exercised as a routed consumer
rather than as a unit.

## Live receipts

The fix was exercised on two stuck journals that pre-fix runs had left behind:

- `$TMPDIR/devrouter-process-preparation/consumer`, journal
  `790366b9ceb5608598e295753592fe2befab393ed4091a6fe7670be360073c71.json`,
  registration and container already gone. The rebuilt CLI reconciled it and
  returned `{"kind": "primary", "stopped": false, "deleted": true,
  "freedRoutes": 0}` with exit 0 before the fixture was rebuilt.
- `$TMPDIR/devrouter-process-preparation/consumer-prune`, journal
  `7640fc8089682278a67f31f8366aaa5ef97ed1f935ab1677cec64db6bd665d93.json`,
  registration present and container pruned. `devrouter stop <path> --json`
  returned exit 0 with `{"kind": "primary", "stopped": false,
  "freedRoutes": 1}` and the journal moved to `phase: idle` with
  `stopProof: {workloadsStopped: true, routesRemoved: true}` at revision 31.

The green qualification run measured at source revision
`c258ae0c2f2dce30ee93150b1303f2695fc4a1cb` with `dirty: false` and bundle hash
`539b79fb0647b3efeaeac55c503160e6e8825aeac055521aca0bd333f81bf475`, the same
bundle that released both stuck journals. On one retained container whose ID
never changed it measured cold ensure 36.1s with one preparation, unchanged reuse
23.0s with the same process PID and no preparation, a changed runtime 28.1s with
a second preparation, a non-destructive stop 35.1s, a stopped resume 25.1s with a
third preparation, an unowned-process refusal (exit 1, two refused adapter
attempts, no completion, no preparation, process and route intact), a
stop-then-ensure recovery 20.0s with a fourth preparation, and a
pruned-population stop 11.0s that settled `idle`/`stopped-by-user`. Peak CLI
resident memory stayed at 73.4-74.9 MiB and every accepted run was a first-attempt
exit 0.
