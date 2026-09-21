---
module: reliability-lifecycle
date: 2026-09-20
problem_type: runtime_error
severity: high
symptoms:
  - "stop --delete refuses on a managed population replaced outside devrouter."
  - "The journal keeps a stopping phase whose stop worker never started."
  - "Journal settlement reports already-settled while ensure remains blocked."
root_cause: The stop intent was recorded before the worker ran its read-only proofs, so a refusal in those proofs stranded a stopping phase that no worker would ever settle.
tags: [devsy, lifecycle, stop-recovery, population, journal]
---

# A refused managed stop left an unstarted stopping intent behind

Status: source, regression and live A/B verified on a disposable fixture;
publication and consumer-side recovery remain separate.

## Problem

An external `docker compose --force-recreate` of a managed container leaves
the recorded container population different while the Devsy registration and
the retained stop baseline still exist. `stop --delete` then records the
stop intent and refuses inside the retained proof with `Retained container
population or immutable identity changed.` The refusal is correct, but it left
the recorded intent behind: `desired: stopped-by-user`, `phase:
stopping`, `stopProof: {workloadsStopped: false, routesRemoved: false}`,
`worker: null`, and the last operation still the drained `COMPLETED`
ensure.

Because the phase was the only thing waiting, `workspace journal settle`
answered `already-settled` by joining the completed operation, and lifecycle
admission blocked every later `ensure` and `ensure --repair` with
`phase is 'stopping' with desired 'stopped-by-user'; wait for the running stop
to finish.` although no stop worker was running. The checkout could only be
freed by deleting the provider registration first, and on the released CLI that
recovery still failed with `Absent stop requires a linked workspace.`

## What did not work

Relaxing the retained proof would report a replaced or surviving workload as a
completed stop. Repeating settlement cannot drain a phase whose operation is
already complete. Treating a recorded stop intent as a running worker blocks the
checkout exactly when nothing is running. The operator recovery of deleting the
exact provider registration is sound, but it depends on the absent-registration
fix for primary checkouts, so it cannot be the only path.

## Solution

[Lifecycle supervision](../../../src/core/reliability-lifecycle.ts) now treats
the stop intent and the stop work as two separate claims. The worker records a
durable pre-mutation boundary
([stopWorkStarted](../../../src/core/reliability-operation-store.ts)) after its
read-only proofs and immediately before a stop may change the environment, and
supervision withdraws the intent it wrote when the worker refuses with that
boundary absent, the same fence, no registered worker, no stop proof and exactly
the operation the intent recorded. Withdrawal restores the snapshot the intent
replaced, so the journal returns to its pre-stop state. A repeated stop that
joins an already-recorded intent never withdraws it, and settlement removes the
boundary again, so a settled record keeps the key set the released CLI accepts.
The admission refusal now names the recovery rerun instead of only `wait for
the running stop to finish`.

## Why this works

Every stop refusal that can happen before the environment changes happens in a
read-only proof, so the durable boundary is positive evidence that a stop may
have mutated state and its absence is positive evidence that it did not. The
fence plus the recorded operation make withdrawal a compare-and-set: a resume,
settlement or newer intent prevents it, and a crash after the boundary stays
fail-closed for an explicit stop retry or settlement. Restoring the exact
snapshot keeps the withdrawal from inventing state that no worker observed.

## Prevention

[Lifecycle supervision regressions](../../../src/core/__tests__/reliability-lifecycle.test.ts)
cover the withdrawal, the retained boundary after a post-boundary refusal, the
joining replay, and the boundary lifecycle; a
[store regression](../../../src/core/__tests__/reliability-operation-store.test.ts)
stores only the positive boundary. The live A/B on the disposable
`$TMPDIR/devrouter-profile-alternation/consumer` fixture reproduced the
stranding on installed 0.1.2 and proved the withdrawal on the fixed build, where
the following `ensure` exited 0 without deleting the registration or
recreating the externally recreated container.

## Live receipts

- `/private/tmp/devrouter-live-env-receipts/stop-withdrawal/RECEIPT.md` with
  `run4.log` (19 PASS, 0 FAIL) at source `5129601a` plus the slice,
  bundle sha256
  `6190d98e9509964ed49bcfe3bc04b987fce547a743d37a0db2eb1be8522c3e5c`, and
  the earlier stuck-stop evidence in
  `/private/tmp/devrouter-live-env-receipts/mount-unwind/RECEIPT.md`.
- One interim finding matters for release compatibility: writing an explicit
  `stopWorkStarted: null` on settled records made installed 0.1.2 refuse
  every lifecycle command for that checkout with `Reliability record contains
  unsupported fields.`, which is why settlement now deletes the field instead.
