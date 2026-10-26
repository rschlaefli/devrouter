---
module: controller-continuity
date: 2026-10-26
problem_type: logic
severity: high
symptoms:
  - "A pre-sleep generation remains renewable after a short host suspend."
root_cause: Matching wall and monotonic deltas below the scheduling-gap threshold do not identify every host wake.
tags: [continuity, suspend, sessions, capacity, fail-closed]
---

# A short sleep can retain stale session authority

Status: corrected at source; exact-artifact short-sleep verification remains open.

Timer discontinuity detection cannot identify every suspend. A sleep shorter
than the scheduling-gap threshold can advance wall and monotonic clocks by
matching amounts. Increasing the requested sleep duration exercises the long-gap
branch, but cannot prove the short-sleep behavior.

`src/core/host-wake.ts` reads macOS's kernel wake identity as an opaque unsigned
counter. Session authority and capacity collection sample it synchronously at
their existing decision boundaries. A changed value follows the existing
discontinuity paths, retaining unresolved consumers and invalidating prior
generation readiness and capacity evidence. Missing evidence refuses fresh
grants without disabling exact withdrawal or completion of committed stops.

Capacity timestamp watermarks alone are insufficient: an identical sample from
before a wake can still be young enough for admission. Retain its continuity
fence as well, so losing or changing the wake identity cannot reuse that sample.

Deterministic session, server, monitor and capacity regressions exercise a short
gap with matching clocks and a changed wake identity. Preserve the failed short
receipt alongside any longer passing receipt; those are separate acceptance
cells. Other platforms retain their existing timer checks and need their own
bounded wake signal before claiming equivalent short-sleep coverage.
