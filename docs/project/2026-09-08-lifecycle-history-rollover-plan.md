# Manual lifecycle history rollover

Status: approved reliability-roadmap correction; native planner design passed.
Owner: main. Executor: Gauss. Branch: rs/lifecycle-history-rollover.
Target: main. Baseline: 9be6df2d0abd797017a39d657e1aaa319d062e00 (v0.0.60).

## Outcome and authority

Ordinary manual ensure and exec must continue beyond 128 settled operations
without deleting the lifecycle journal or asking agents to repair it manually.
Preserve bounded history and reject delayed work using the existing revision fence.
This is source implementation under the approved reliability roadmap, including
focused verification, independent reviews, ordinary commit/push and draft PR.
The first delivery boundary is a reviewed draft PR with passing affected checks.
No runtime deletion, shared VM restart, host OOM, machine policy change or
Klicker runtime mutation is part of this fix. Publishing another patch release
is not claimed by source delivery.

The exact waiting-consumer cause remains unconfirmed: its generic error has
several possible guards. Do not recommend journal edits or repeated ensure calls.
The app cannot currently reach its supplied task ID to obtain sanitized state.

## Verified defect

The released model appends history for every new manual operation and blocks
when the history reaches 128 entries. Stop does not retire it. A pure-source
reproduction against v0.0.60 on Node 24.17.0 completed and drained 128 ensures;
the next operation was blocked before and after successful stop proof.
Reproduction files: /private/tmp/devrouter-history-limit-release60.
No runtime or real journal was touched.

## Correction and invariants

Keep duplicate/conflict and operation eligibility checks before rollover.
Only manual admission may retire history, only when its current operation is
settled and drained or absent, with no active worker. Retire the oldest eligible
settled, drained entry needed to make one slot; preserve the prior current entry
and every uncertain or referenced record. If no entry qualifies, keep refusal.

Advance intentRevision, retire history and accept the next fresh operation in
the same atomic journal transaction. Preserve observation freshness and return
the new fence to the worker. Counter exhaustion and failed acceptance leave the
persisted record unchanged. Delayed events retain their old fence and are stale.
Manual CLI creates fresh UUIDs internally and exposes no caller-supplied request
ID. Do not reattach a current fence to a delayed manual request.

Capacity-managed history and externally retryable request IDs remain unchanged.
Rollover cannot authorize uncertain completion, drain a worker by assumption,
or replace positive stop/reconciliation evidence.

## Ownership and validation

Main owns journal/fence integration, exact diff verification and delivery.
Gauss owns the minimal model correction and focused model/lifecycle regression
coverage. Native planner Ampere reviewed the complete correction frontier.
Independent simplification and risk review cover the committed slice; final
review covers the integrated fix before draft delivery.

Validate more than 256 settled manual operations including stop/start, bounded
history, preserved recent duplicate/conflict behavior, stale old request and
worker events, retained uncertainty, counter exhaustion, and unchanged managed
semantics. Verify the journal transaction cannot persist retirement under an old
revision. Run affected model/lifecycle tests and repository-native static checks;
reuse unchanged evidence. Pure model/source tests need no application runtime.
Rollback is an ordinary source revert; never restore a prior journal snapshot.

## Progress

2026-09-08: reproduced the released history limit; accepted native planner's
manual-only rollover contract. Created the isolated worktree from released main.
Implementation is committed at 9a346ad. All 63 focused tests and 1212 full
unit tests pass, together with typecheck, Biome, Knip, documentation policy,
knowledge validation, build and isolated package smoke. The first full-suite
attempt lacked sandbox process identity access; the host-visible rerun passed.
Receipts: /private/tmp/devrouter-history-rollover-full-tests-host.log and
/private/tmp/devrouter-history-rollover-package.log. Native simplification and
independent risk review pass with no actionable findings. Integrated final
review and draft PR delivery remain pending. No new release is claimed.

When integrating this fix into the capacity branch, retain an explicit manual-only
rollover condition: that branch removes the released handler's leading manual
policy guard. Its externally retryable managed request IDs must not inherit
manual history retirement. This is an integration requirement, not behavior
present in the released-main fix.

Final review identified ADR 0008's stale unconditional history-exhaustion rule.
Amended its manual lifecycle extension to document settled-record retirement,
atomic fence advancement, retained uncertainty, and unchanged capacity-managed
admission. This records the approved contract without expanding runtime authority.
