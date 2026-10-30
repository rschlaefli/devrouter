---
module: reliability-lifecycle
date: 2026-10-30
problem_type: runtime_error
severity: high
symptoms:
  - "Explicit repair refuses a non-degraded retained runtime after host preparation has already run."
  - "The known eligibility refusal appears as an interrupted journal operation."
root_cause: Repair eligibility was checked after repository preparation, and the worker classified ordinary thrown errors as unknown completion.
tags: [lifecycle, repair, preparation, journal, ownership]
---

# Preparation ran before a known repair refusal

Status: source correction in [draft PR #169](https://github.com/rschlaefli/devrouter/pull/169);
publication and consumer acceptance remain separate.

## Problem

The installed CLI could run a repository's preparation command before refusing
repair of a retained ready runtime. Its outer worker then recorded the thrown
eligibility error as interrupted, even when the worker returned a definite
failure and drained. Diagnostic advice also proposed explicit repair without
proving that a degraded record existed.

## What did not work

Typing the existing late refusal would misclassify a failure after possible
repository effects. The journal effect counter also includes bookkeeping claims;
its value cannot establish whether preparation or application effects occurred.
Blanket conversion of thrown errors to completed failures would erase uncertainty
for other failures and arbitrary commands.

## Solution

[Ensure](../../../src/core/workspace-ensure.ts) checks explicit repair status
inside the lifecycle lock before preparation. Only that early check throws the
known-refusal type. Later eligibility and ownership revalidation remain intact.
[Worker bookkeeping](../../../src/core/reliability-lifecycle.ts) records a
nonzero completion only for the matching running operation, worker and fence.
Owned cancellation or disconnection remains interrupted; a stale owner cannot
replace the current result. Other errors retain the existing unknown path.

Recovery advice uses ordinary ensure, which already selects eligible degraded
recovery. Explicit refusal points to exact-checkout read-only diagnostics.
This advice does not grant authority to run unqualified repository hooks.

## Prevention

Existing unit tests protect preparation ordering and stale/canceled ownership.
The installed lifecycle qualifier exercises ready and stopped retained states,
checks unchanged preparation and runtime state, and proves that ordinary ensure
remains usable after the refusal. Consumer hook preservation still needs the
consumer owner's producing evidence.
