# Reliable admission and process-inspection diagnostics

## Approval summary

Agents should not have to stop healthy tooling to prepare their environment.
Extend the existing exec admission wait to ensure, preserving serialization,
original intent, cancellation and exact ownership. When process inspection is
unavailable, explain the host permission requirement without weakening locks.
The user approved autonomous implementation, verification and scoped delivery.
Existing explicit merge/release authority remains subject to reviews and CI.
No machine policy, provider configuration, data deletion or shared VM changes
are included. Memory admission and network allocation retain their existing owners.

Success means both callers wait behind healthy workers, dispatch at most once,
and stop or cancellation prevents later admission. Failed process inspection
must leave locks and protected operations untouched. Use synthetic subprocess
qualification and bounded eLearning dogfood; finish the canary stopped with zero
routes. Do not claim full OOM protection.

## Execution details

Branch rs/lifecycle-wait-diagnostics starts at main 7de37e6. Main owns lifecycle
integration, scripts, docs, reviews and publication. Executor Hypatia owns only
file-lock.ts and file-lock.test.ts. Explorer Dirac maps unfinished capacity
integration in its separate worktree. Networking remains with its existing task.
Critical-path lifecycle coupling keeps those edits in main.

Primitive impact: reuse operation identity, ownership and atomic admission;
extend ensure to compose the existing healthy-worker waiting contract. No new
queue, state schema, FIFO guarantee, lock fallback or worker protocol.

Preserve one copied options/argv snapshot and one set of invocation IDs. Retain
the original fence and 30-minute admission deadline, 250ms polling and 10-second
values-free progress. Wait outside all locks; retry only typed admission
contention after undispatched helper cleanup. Stop supersedes waiters immediately.
Unknown identity, completion and uncertain send remain conservative failures.
Keep processBirthIdentity and lock reclamation semantics unchanged.

## Verification and review

Cover ensure/exec behind both worker kinds, copied inputs, no writes while waiting,
stop fencing, timeout, SIGINT/SIGTERM, raced admission and no replay. Generalize
applicable worker boundary tests and add installed synthetic overlap qualification.
Force unavailable procfs and failed ps to prove lock failure causes no effects;
never pin diagnostic prose or emit raw process arguments/environment.
Run focused checks, full tests, build and package qualification. Review the
committed slice with simplifier and risk reviewer, then integrated final review.
Reuse unchanged earlier evidence; fix only affected findings.

## Progress

Planner Pauli approved this contract at 7de37e6, correcting the proposed deadline
to the existing thirty minutes. Main accepted all acceptance requirements.
Optional AGY opposing review has a reusable headless file-access failure in this
task; it is not counted as a review. No new permission or routing setup attempted.

Implementation46089c8 passes1382 tests in92 suites, formatting, typecheck,
Knip, docs policy and knowledge validation. Clean committed packed lifecycle
qualification passes with dirty=false, including ensure behind tooling, no replay,
stop fencing and cancellation. Simplifier Sartre returns DONE with no findings.
The executor diagnostic correction removed prose-pinning assertions and retained
only lock preservation, no-effect and values-free error checks.

Live exact eLearning canary resumed successfully. A20-second synthetic tooling
command completed with exit7; a concurrent ensure reported waiting, then completed
with exit0 and reused the same container and application PID268. No app failure,
OOM injection, deletion or shared VM change occurred. Final non-destructive stop
and route readback follow; correctness and integrated final reviews remain pending.
