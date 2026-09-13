---
module: capacity-ownership-resolver
date: 2026-09-11
problem_type: integration
severity: high
symptoms:
  - "Every capacity-enrolled ensure on a loaded machine ends INTERRUPTED with 'Capacity effect authority is absent or stale.' after one successful renewal."
  - "The controller's runtime domain sample reads unknown on roughly every second observation tick while the enrolled runtime is healthy and running."
  - "Renewal logs show a fresh runtime sample age of a few milliseconds with no measurement error, because the failed domain was replaced by the collection catch block."
root_cause: The ownership population proof compared mutable lifecycle bookkeeping rather than population identity, so an observation that straddled dispatch, startup-witness clearing, or completion failed its own consistency check and reported an unknown sample.
tags: [capacity, controller, ownership, admission, ensure, sampling]
---

# Capacity ownership proof fails on ordinary lifecycle progress

## Status

Observed and fixed on 2026-09-11 during the authorized eLearning canary
dogfood of the controller capacity work. This record captures the runtime
evidence and the remediation that shipped with it.

## Exact evidence

- Checkout: /Users/rschlae/Git/tc/elearning/trees/rs/reliability-canary,
  workspace rs-reliability-canary, provider devsy, profile full.
- Machine policy: ~/.config/devrouter/controller/capacity-policy.json,
  admissions enabled, revision 1, maxSampleAgeSeconds 15.
- Domain samples are collected by the controller once per tick; the whole
  collection took 4.2-6.9 seconds with the canary's three running containers.

## Observed behavior

1. ensure is admitted, dispatches, and reports RUNNING, with authority
   extended once.
2. The next observation tick reports the runtime domain as `unknown` and the
   host domain as `normal`; renewal refuses the extension.
3. Authority lapses at its existing deadline, the worker's next effect fails,
   and the operation ends INTERRUPTED with `Capacity effect authority is
   absent or stale.` even though the application is healthy.

Instrumented runs named the two refusal sites: `Capacity ownership generation
changed during collection.` (between the before/after population reads of one
probe) and `Capacity ownership records changed before publication.` (after the
probe finished).

## Root cause

`capacity-ownership-resolver.ts` proved that the enrolled population was stable
for the duration of one observation by comparing journal records. The
controller rewrites that record every second it observes, and a start moves it
through several states, so the comparison failed on bookkeeping alone.

A second pass narrowed the comparison to a projection, but the projection still
carried lifecycle state: `startupWitness`, `worker`, `phase`, `operation`, and
`stopProof`. Recorded over one ensure, only the witness moved, and it moved
exactly when the proof was running:

| Offset | Change |
| --- | --- |
| +5.5s | phase recovering -> queued, operation INTERRUPTED -> NOT_STARTED |
| +6.3s | startupWitness null -> present |
| +12.5s | worker null -> present, phase queued -> starting, DISPATCH_RECORDED |
| +13.8s | phase starting -> verifying, operation RUNNING |
| +23.1s | startupWitness present -> null |
| +29.9s | worker -> null, phase verifying -> stable, operation COMPLETED |

`environmentId`, `enrollment`, `composeProject`, `devpodId`, and `stopBaseline`
never changed across the same run. The runtime probe reads the owned population
before and after sizing every running container, so a probe that straddled any
of those transitions failed its own consistency check. The collector catch then
substituted an `unknown` sample with a fresh timestamp, which is why the
refusal looked like healthy fresh evidence rather than a collection failure.

## Fix

- Compare only population identity: `environmentId`, `executionPolicy`,
  `enrollment`, Compose project, DevPod, and retained runtime baseline.
- The owned container set is still compared directly between the before and
  after reads, and the daemon ownership index is still compared before and
  after, so real population churn is still caught.
- A missing or foreign retained baseline is still refused rather than waved
  through; dropping the witness from the comparison cannot silently weaken the
  container proof, because the proof for the current record is always applied.
- The runtime probe budget covers two daemon reads plus per-container sizing;
  a tighter bound turned a slow but healthy read into an unknown sample.

## Verification

- Focused ownership tests 30 pass; full suite 2127 pass across 141 files.
- Live canary after the fix: ensure COMPLETED (exit 0, application ready),
  warm re-ensure recreated nothing, two execs exited 0, and the startup
  reservation settled to a steady reservation on the same reservation id.

## Prevention

An ownership proof is about which resources are owned, never about how far a
lifecycle has progressed. When a stable identity must be compared across a
sampling window, project the identity explicitly and keep mutable progress out
of it; if a guard must fail closed, make the refusal name the field that moved
so the next investigation does not have to instrument the failure again.
