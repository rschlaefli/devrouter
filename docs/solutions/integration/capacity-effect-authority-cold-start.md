---
module: reliability-lifecycle
date: 2026-09-11
problem_type: integration
severity: high
symptoms:
  - "An admitted ensure on a capacity-enrolled checkout exits nonzero with a capacity effect authority error and a degraded-drift rollback while the runtime actually starts and the application is healthy."
  - "An admitted exec fails with a controller operation request that was not acknowledged."
  - "The controller reports a stale or absent controller session binding for a supervised operation."
  - "With capacity enrollment active and no controller process, ensure dies on a missing or stale controller control socket instead of starting or naming one."
root_cause: Capacity effect authority is bounded by capacity-sample freshness, so a cold start that outlives the sample age cannot apply its later lifecycle effects; the CLI also submits its first supervised operation exactly once against a session that an environment binding change can invalidate.
tags: [capacity, controller, admission, ensure, exec, effect-authority, reliability]
---

# Capacity effect authority expires during a long cold start

## Status

Observed on 2026-09-11 during the authorized eLearning canary dogfood of the
released CLI 0.0.72. This record captures the runtime evidence and the leading
source-level explanation. It contains no source fix; the remediation is the next
slice, and the runtime was left stopped with zero routes.

## Exact evidence

- CLI: devrouter 0.0.72, installed globally (Volta and Homebrew installs both
  updated before the run).
- Checkout: /Users/rschlae/Git/tc/elearning/trees/rs/reliability-canary,
  workspace rs-reliability-canary, provider devsy, profile full.
- Machine policy: ~/.config/devrouter/controller/capacity-policy.json,
  admissions enabled, revision 1.
- Journal ~/.config/devrouter/reliability/<sha256 of repo path>.json:
  version 2, executionPolicy capacity-managed, operationHistory length 128,
  state.operation { kind: ensure, drained: true, status: INTERRUPTED },
  capacity.validUntilMs 0, writtenByVersion 0.0.72.

## Observed behavior

1. ensure with no controller process:
   Error: ENOENT: no such file or directory, lstat .../controller/control.sock.
   A raw filesystem error, not an actionable refusal.
2. After the controller was started and then died with its session:
   Error: Controller unavailable. The stale control.sock and owner.lock files
   remained on disk.
3. With a live controller, ensure reported Error: Capacity effect authority is
   absent or stale. Rollback left degraded drift: configuration ...; services ...;
   processes ...; routes ....

   The reported drift did not match the runtime. docker ps showed
   default-rs-101ce-app-1, -postgres-1, and -azurite-1 up, devrouter status --json
   reported every desired app, service, and process active, and the namespaced
   host https://elearning.klicker.rs-reliability-canary.localhost/api/health
   returned 200.
4. devrouter exec with echo ok reported Error: Controller operation request
   1654f744-c271-4bf8-a305-aaa686bfda2d was not acknowledged.
5. The controller wrote: controller operation failed: Controller session binding
   is stale or absent. It later wrote: controller operation failed: Execution
   requires the active capacity profile.

## Leading source-level explanation

Two coupled defects, both in the supervised capacity path.

1. Effect authority tracks sample freshness. assertCapacityEffect in
   src/core/reliability-operation-store.ts rejects any lifecycle effect when
   binding.validUntilMs is not after now. renewLifecycleCapacity in
   src/core/reliability-lifecycle.ts sets that value to the oldest sample time
   plus policy.scheduling.maxSampleAgeSeconds, and returns false when the
   enrollment, runtime endpoint, reservation, or capacity decision no longer
   qualifies. A cold start that runs longer than the sample age therefore stops
   renewing, its later effects are refused, and the lifecycle rolls back after
   the provider start already succeeded. The journal then records INTERRUPTED
   with validUntilMs 0 while the environment runs.
2. The first operation submission is single-shot. In superviseThroughController,
   bind runs once and submitControllerOperation is awaited once; only the follow
   loop re-binds. ControllerSessions.invalidate with a changed binding removes
   sessions, and validate then throws Controller session binding is stale or
   absent. A binding change between the bind and the submit fails the whole
   command instead of retrying the bind.

A third gap is operational: capacity admission needs a running controller, but
there is no supported way to keep one running, and a missing or stale socket
surfaces as a raw ENOENT rather than a bounded, actionable state.

## What is not established

The sample-age explanation is inferred from the code path plus the persisted
validUntilMs of 0; it was not confirmed with an isolated, instrumented repro, so
the retirement and renewal preconditions remain candidates. The contribution of
the saturated 128-entry journal with a retained INTERRUPTED current operation is
also unresolved. Determining whether a fresh journal fails the same way is the
first step of the next slice.

## Verification performed

The non-destructive stop ended correctly, reporting that it stopped DevPod
rs-reliability-canary and freed 2 routes for the workspace. Containers were left
exited with data retained, the host route state held zero references to the
workspace, and the live Traefik API reported zero HTTP and zero TCP routers for it.

## Prevention

A capacity-enrolled checkout must either complete its admitted operation or fail
with a remediation the agent can act on. Concretely: renew or re-verify effect
authority for the duration of the operation rather than only while samples are
fresh; never let a provider start succeed and then report a failed rollback to
the caller; re-bind and retry the first submission with the same idempotent
requestId; and fail with a bounded, actionable message when no controller is
available instead of a raw socket ENOENT.
