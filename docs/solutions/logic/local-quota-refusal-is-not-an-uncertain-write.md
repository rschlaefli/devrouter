---
module: remote-previews
date: 2026-10-29
problem_type: logic
severity: medium
symptoms:
  - "A preview cannot prove absence after a creation request was refused locally."
root_cause: "An admission refusal was recorded as an uncertain remote mutation."
tags: [northflank, previews, quotas, ownership]
---

# Local quota refusal can leave a phantom creation claim

Status: synthetic source regression verified; live qualification pending.

## Problem

The provider persists creation intent before sending a once-only mutation. Quota admission in the transport can reject that mutation before fetch. Treating this refusal like a lost remote response leaves ownership uncertain even though nothing was created. Stop then correctly refuses to infer absence from a missing, unobserved resource.

## What did not work

Checking capacity only after the claim creates this gap. Checking only before the claim also misses concurrent capacity consumption during its persistence. Blindly retrying all quota failures could replay a genuinely dispatched mutation.

## Solution

[The transport](../../../src/core/preview/providers/northflank-api.ts) distinguishes local refusal from a dispatched HTTP 429. [The provider](../../../src/core/preview/providers/northflank.ts) checks capacity before claiming creation and records rejection if a later local refusal proves the POST never left the process. A dispatched failure retains uncertainty and must be reconciled without replay.

## Prevention

[Provider regressions](../../../src/core/preview/__tests__/northflank.test.ts) cover low initial quota and quota exhaustion during the ownership claim. Both require zero creation mutations and successful stop plus absence verification. Request-count tests separately prevent completed-phase reads from consuming the quota while activation remains pending.
